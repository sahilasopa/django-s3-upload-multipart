# S3 Upload Widget — Project Flow

This document describes how the Django S3 upload widget works: from the form field and widget rendering to the browser posting the file directly to S3 and saving the resulting URL.

**Note:** Despite the project name, uploads use **presigned POST** (policy-based) to S3, not the S3 Multipart Upload API. The file is sent in a single `POST` from the browser to S3.

---

## Overview

1. **Django** renders a widget that includes a file input, a hidden URL field, and a policy URL.
2. **User** selects a file → frontend asks Django for signed upload parameters.
3. **Django** validates the request and returns an AWS policy payload (and optional private URL).
4. **Frontend** POSTs the file **directly to S3** using that payload (no file passes through Django).
5. **S3** responds with `201` and a `Location` URL; the widget stores that URL in the hidden input.
6. **Form submit** sends the stored S3 URL; the model/field can normalize it to an S3 key if needed.

---

## 1. Django Side

### Configuration

- **`settings.S3UPLOAD_DESTINATIONS`**  
  Dict of named destinations. Each entry can define:
  - `key` — path prefix or callable(filename) or `"/"` for filename only
  - `auth` — callable(request.user) for permission check
  - `allowed_types` — MIME types (or `"*"`)
  - `allowed_extensions` — e.g. `['.jpg', '.png']` or `"*"`
  - `acl` — e.g. `"public-read"` or `"private"`
  - `bucket`, `cache_control`, `content_disposition`, `content_length_range`, `server_side_encryption`, etc.
- **`settings.AWS_ACCESS_KEY_ID`**, **`AWS_SECRET_ACCESS_KEY`**, **`AWS_STORAGE_BUCKET_NAME`**, **`S3UPLOAD_REGION`**  
  Used to build the bucket URL and sign the policy.

### Field and Widget

- **`s3upload.fields.S3UploadField`**  
  Model field that stores the file reference (URL or path). It is configured with a `dest` that must exist in `S3UPLOAD_DESTINATIONS` and uses `S3UploadWidget` for forms.
- **`s3upload.widgets.S3UploadWidget(dest=...)`**  
  Renders the upload UI:
  - Loads JS: `s3upload/js/django-s3-uploads.min.js`
  - Loads CSS for progress bar and styles
  - Renders template `s3upload/s3upload-widget.tpl` with:
    - `policy_url` → Django view URL for getting upload params (e.g. `/s3upload/get_upload_params/`)
    - `dest` → destination name
    - `name` / `element_id` for the hidden input
    - `file_url` / `file_name` when there is an existing value

### Template (`s3upload-widget.tpl`)

- Root element: `<div class="s3upload" data-policy-url="{{ policy_url }}">`
- Hidden inputs: file URL (value submitted with form), destination (`dest`)
- File input: `input.s3upload__file-input`
- Progress bar and error area
- Link to current file and “Remove” control

### View: `get_upload_params`

- **URL:** `get_upload_params/` (name: `s3upload`)
- **Method:** POST
- **POST data:** `type` (MIME), `name` (filename), `dest` (destination key from `S3UPLOAD_DESTINATIONS`)

**View logic:**

1. Resolve `dest` from `S3UPLOAD_DESTINATIONS`; return 400 if missing.
2. Apply `auth(request.user)` if defined; return 403 if not allowed.
3. Validate MIME type and file extension against `allowed_types` / `allowed_extensions`.
4. Build S3 object key: from callable `key(filename)`, or `key + "/" + filename`, or just `filename` if `key == "/"`.
5. Call **`create_upload_data()`** in `s3upload.utils` to get the presigned POST payload.
6. If `acl == "private"`, optionally generate a signed download URL and include it in the response.
7. Return JSON: `{ "aws_payload": {...}, "private_access_url": "..." }`.

### Utils: `create_upload_data()`

- Builds an **AWS Signature Version 4** presigned POST policy:
  - Policy document with expiration (e.g. 5 minutes), bucket, acl, key prefix, `success_action_status: 201`, credentials, algorithm, date, content-type, and any optional conditions (token, cache-control, content-disposition, encryption, content-length-range).
  - Encodes policy as base64 and signs it with HMAC-SHA256 using the secret key and AWS SigV4 key derivation (date → date_region → date_region_service → signing_key).
- Returns a dict suitable for the browser to POST to S3:
  - `form_action` → bucket endpoint URL (e.g. `https://<bucket>.s3.<region>.amazonaws.com`)
  - `key`, `acl`, `content-type`, `policy`, `x-amz-*` fields, plus any optional headers.
- The browser must send these as form fields and append the file last; S3 expects the file field name (e.g. `file`).

---

## 2. Frontend (JavaScript)

### Initialization

- On `DOMContentLoaded` (or custom event `s3upload:init`), the script finds all `.s3upload` elements.
- For each element it:
  - Creates a Redux store with `configureStore({ element })`
  - Instantiates `View(element, store)` and calls `view.init()`.

### View (`components/index.js`)

- **init()**  
  Caches references to:
  - `.s3upload__file-url` (hidden input for the final URL)
  - `.s3upload__file-input` (file input)
  - `.s3upload__file-dest` (hidden, destination name)
  - `.s3upload__file-link`, `.s3upload__error`, `.s3upload__bar`
  - Binds:
    - **change** on file input → `getUploadURL`
    - **click** on remove link → `removeUpload`
  - Subscribes to the store to update:
    - Filename/link and hidden URL when upload completes or is removed
    - Error message
    - Progress bar width

### Upload flow (actions)

1. **User selects a file**  
   → `getUploadURL(event)` runs: reads `file`, `dest`, and `data-policy-url` from the widget, dispatches `clearErrors()` and `getUploadURL(file, dest, url, store)`.

2. **getUploadURL (actions/index.js)**  
   - POSTs to the Django `policy_url` with `FormData`: `type`, `name`, `dest`; headers include `X-CSRFToken`.
   - On **200**:  
     - Dispatches `receiveSignedURL(data.private_access_url)` and `receiveAWSUploadParams(data.aws_payload)`.  
     - Then dispatches **`beginUploadToAWS(file, store)`**.
   - On 400/403/415 or other errors: dispatches error state and `didNotReceivAWSUploadParams()`.

3. **beginUploadToAWS**  
   - Reads `aws_payload` from the store; URL = `aws_payload.form_action`.
   - Builds a new `FormData`, appends all payload keys (except `form_action`) then appends the file under the key `file`.
   - Sends **POST** to the S3 bucket URL with this form (no custom headers needed for the policy).
   - Uses `request()` with:
     - **onProgress** → `updateProgress(progress)` and `s3upload:progress-updated` event
     - **onLoad**:
       - **201**: parses XML response for `<Location>`, extracts URL, dispatches `completeUploadToAWS(filename, url)` and fires `s3upload:file-uploaded`
       - Else: dispatches `didNotCompleteUploadToAWS()` and `addError(...)` (e.g. too small, too large, generic)
     - **onError** → `didNotCompleteUploadToAWS()` and generic error

4. **completeUploadToAWS**  
   - Reducer sets `filename`, `url`, clears `uploadProgress`, sets `isUploading: false`.

5. **Store subscription (renderFilename)**  
   - When `url` and `filename` are set, the view sets the link text and href, and sets **`this.$url.value = url.split("?")[0]`** so the hidden input holds the final S3 URL (without query string). That value is what gets submitted with the form.

---

## 3. End-to-end sequence

```
[User selects file]
       ↓
[Widget: POST /s3upload/get_upload_params/  type, name, dest + CSRF]
       ↓
[Django: validate dest, auth, MIME, extension → create_upload_data() → JSON]
       ↓
[Widget: POST to S3 bucket URL with policy + x-amz-* + file]
       ↓
[S3: 201 + <Location>URL</Location>]
       ↓
[Widget: parse URL → store in state → write to hidden input]
       ↓
[User submits form → Django receives S3 URL in field]
       ↓
[Model/Field: pre_save can normalize URL to S3 key via get_s3_path_from_url if needed]
```

---

## 4. Important files

| Layer        | File(s) |
|-------------|---------|
| Model field | `s3upload/fields.py` |
| Form widget | `s3upload/widgets.py` |
| Template    | `s3upload/templates/s3upload/s3upload-widget.tpl` |
| Params view | `s3upload/views.py` → `get_upload_params` |
| URL config  | `s3upload/urls.py` → `get_upload_params/` |
| Signing     | `s3upload/utils.py` → `create_upload_data`, `get_bucket_endpoint_url` |
| Frontend    | `s3upload/src/app/` (actions, components, store, reducers) |
| Built JS    | `s3upload/static/s3upload/js/django-s3-uploads.min.js` |

---

## 5. Events (for integration)

- **`s3upload:file-uploaded`** — detail: `{ filename, url }`
- **`s3upload:progress-updated`** — detail: `{ progress }`
- **`s3upload:error`** — detail: `{ status, error }`
- **`s3upload:clear-upload`** — when user removes the upload
- **`s3upload:init`** — dispatch to init widgets (e.g. after dynamically adding markup); optional `event.detail.selector` to override `.s3upload`

This flow keeps file data off the Django server and avoids timeouts by uploading directly to S3 using a short-lived presigned POST policy.
