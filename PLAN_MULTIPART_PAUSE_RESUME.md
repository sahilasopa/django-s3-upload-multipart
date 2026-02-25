# Plan: Multipart Upload with 6MB Chunks and Pause/Resume

This document outlines a concrete plan to add **S3 multipart upload**, **6MB chunk size**, and **pause/resume** to the existing django-s3-upload widget, while keeping the current presigned-POST flow available (e.g. for small files or backward compatibility).

---

## 1. Target behavior

- **Multipart:** Use S3’s multipart API: CreateMultipartUpload → UploadPart (per chunk) → CompleteMultipartUpload.
- **Chunk size:** 6 MB per part (S3 allows 5 MB–5 GB per part; last part can be smaller).
- **Pause:** User can pause an in-progress upload; no new parts are sent; in-flight request can be aborted.
- **Resume:** User can resume; only parts not yet completed are uploaded; then CompleteMultipartUpload is called. Resume is **in-session only** (same page; we keep the `File` and state in memory). Optional later: “resume after refresh” by re-selecting the same file and using S3 ListParts (see §6).

---

## 2. Backend (Django) changes

### 2.1 New settings (optional)

- **`S3UPLOAD_MULTIPART_CHUNK_SIZE`** — default `6 * 1024 * 1024` (6 MB). Used when initiating multipart and returned to the client so the frontend uses the same chunk size.
- **`S3UPLOAD_MULTIPART_ENABLED`** — optional; if `False`, widget can still use the existing presigned POST only (no new endpoints required for multipart).

### 2.2 New API endpoints (new URLs + views)

Reuse the same validation as `get_upload_params` (dest, auth, MIME, extension, key) so multipart is subject to the same rules. Suggested routes:

| Action | Method | Purpose |
|--------|--------|--------|
| Initiate multipart | POST | Create multipart upload; return `upload_id`, `key`, `bucket` (or endpoint), `part_size`, `total_parts`. |
| Presign part URL | POST | Given `upload_id`, `key`, `part_number` → return presigned PUT URL for that part. |
| Complete multipart | POST | Given `upload_id`, `key`, `parts: [{PartNumber, ETag}]` → call S3 CompleteMultipartUpload; return final object URL (or 201 location). |
| Abort multipart | POST | Given `upload_id`, `key` → call S3 AbortMultipartUpload (cleanup on cancel / error). |
| (Optional) List parts | GET | Given `upload_id`, `key` → return list of completed parts (for “resume after refresh” later). |

**Initiate multipart (sketch):**

- Input: same as current `get_upload_params`: `dest`, `name`, `type` (and CSRF).
- Reuse existing dest/key/auth/allowed logic from `get_upload_params`.
- Call boto3 `s3.create_multipart_upload()` with bucket, key, ContentType, ACL, and any optional params (e.g. ServerSideEncryption) from dest config.
- Compute `total_parts = ceil(file_size / part_size)`. File size can be sent in POST so the server can validate max size and return `total_parts`; alternatively frontend can compute from `File.size`.
- Response: `upload_id`, `key`, `bucket` (or `bucket_endpoint`/region), `part_size` (e.g. 6MB), `total_parts`, and optionally `private_access_url` template or a note that it will be returned on complete for private ACL.

**Presign part URL:**

- Input: `upload_id`, `key`, `part_number`.
- Server must validate that this `upload_id`/`key` is allowed for this user (e.g. store upload_id in session or signed token when initiating, or accept upload_id only for same session). Avoid accepting arbitrary upload_ids from other users.
- Use boto3 `s3.generate_presigned_url('upload_part', Params={Bucket, Key, UploadId, PartNumber}, ExpiresIn=...)` (method PUT). Typical expiry 15–60 minutes.
- Response: `url` (presigned PUT URL).

**Complete multipart:**

- Input: `upload_id`, `key`, `parts`: list of `{PartNumber, ETag}` (ETag from S3 response when uploading each part).
- Validate ownership/session as above.
- Call `s3.complete_multipart_upload(Bucket, Key, UploadId, MultipartUpload={'Parts': parts})`.
- Build final object URL (same logic as today: bucket endpoint + key; for private ACL generate signed download URL).
- Response: `url` (and optionally `private_access_url`), so the widget can set the hidden input and finish the flow like the current widget.

**Abort multipart:**

- Input: `upload_id`, `key`.
- Call `s3.abort_multipart_upload(Bucket, Key, UploadId)`.

### 2.3 Where to put the code

- **New views:** e.g. in `s3upload/views.py`: `initiate_multipart`, `presign_part_url`, `complete_multipart`, `abort_multipart` (and optionally `list_parts`). Each can call a small helper that runs the same dest/key/auth/validation as `get_upload_params` where applicable (initiate needs it; presign/complete/abort need upload_id/key and a way to tie them to the user/session).
- **New utils:** In `s3upload/utils.py` add functions such as:
  - `create_multipart_upload(bucket, key, content_type, acl, ...)` → returns `upload_id`.
  - `get_upload_part_presigned_url(bucket, key, upload_id, part_number, ...)` → returns URL.
  - `complete_multipart_upload(bucket, key, upload_id, parts)` → returns success; caller builds URL.
  - `abort_multipart_upload(bucket, key, upload_id)`.
- **URLs:** Add new paths in `s3upload/urls.py`, e.g. `initiate_multipart/`, `presign_part_url/`, `complete_multipart/`, `abort_multipart/`.

### 2.4 Server-side state for multipart (security)

To avoid one user completing another user’s upload, associate `upload_id` with the request:

- **Option A (simplest):** Store `(upload_id, key, bucket)` in Django session when initiating; on presign/complete/abort, require the same session and look up upload_id/key.
- **Option B:** Encode a signed token at initiate (e.g. upload_id + key + user_id + expiry) and require that token on presign/complete/abort instead of session.

Session-based is usually enough and keeps the plan simple.

---

## 3. Frontend (JavaScript) changes

### 3.1 Choosing upload mode

- **Option A:** Use multipart only when `file.size > part_size` (e.g. > 6 MB); otherwise keep using the existing presigned POST flow (no backend change for small files).
- **Option B:** Add a widget option (e.g. `use_multipart=True`) so the form can force multipart even for small files.
- **Option C:** Always use multipart for all files (simplest UX; more API calls for tiny files).

Recommended: **Option A** — use multipart when file is larger than chunk size (e.g. > 6 MB); otherwise use current flow. This minimizes changes for small uploads and gives pause/resume only where it’s useful.

### 3.2 New state (Redux)

Extend `appStatus` (or add a slice) to support multipart and pause:

- **Multipart context:** `uploadId`, `key`, `bucketEndpoint`, `partSize`, `totalParts`, `completedParts`: `{ partNumber → { etag } }`, `isPaused`, `currentPartRequest` (reference to abort the in-flight XHR).
- **Existing:** `filename`, `url`, `uploadProgress`, `error`, `isUploading` stay; they can represent either single POST or multipart completion.

Alternatively keep “multipart” state in a separate reducer (e.g. `multipartUpload`) and have the component/actions coordinate so that on completion they dispatch the same `completeUploadToAWS(filename, url)` as today, keeping the rest of the UI unchanged.

### 3.3 New actions / flow

1. **Start upload (multipart path):**
   - User selects file; if `file.size > CHUNK_SIZE` (6 MB): dispatch “initiate multipart” (POST to new initiate endpoint with dest, name, type, and optionally `file_size`).
   - On 200: store `upload_id`, `key`, `part_size`, `total_parts`, `bucket_endpoint`; set `isPaused = false`; then start part upload loop.

2. **Part upload loop (async, e.g. in a thunk or in the action that receives initiate response):**
   - For `part_number = 1` to `total_parts`:
     - If `isPaused` (read from store), break and do not start next part.
     - If `completedParts[part_number]` already exists (e.g. after resume), skip.
     - Request presigned URL for this part (POST presign endpoint with `upload_id`, `key`, `part_number`).
     - Slice file: `file.slice((part_number - 1) * part_size, part_number * part_size)` (last part: to `file.size`).
     - **PUT** the chunk to the presigned URL; set `Content-Length` and optionally no `Content-Type` or the same as init (per S3 docs). Store the XHR so it can be aborted on pause.
     - On 200: read `ETag` from response headers (strip quotes if needed); dispatch “part completed” with `part_number`, `etag`; update progress: e.g. `(completed_parts_count / total_parts) * 100` or by bytes.
     - On error: dispatch error; optionally call abort multipart on server.
   - When all parts are completed: dispatch “complete multipart” (POST complete endpoint with `upload_id`, `key`, `parts: [{PartNumber, ETag}, ...]`).
   - On 200: response contains final `url`; dispatch same `completeUploadToAWS(filename, url)` as current flow so the hidden input and UI match existing behavior.

3. **Pause:**
   - Dispatch “pause” (set `isPaused = true`).
   - If there is an in-flight XHR for the current part, call `xhr.abort()`.
   - Do not start the next part (loop checks `isPaused`).

4. **Resume:**
   - Dispatch “resume” (set `isPaused = false`).
   - Restart the part loop from part 1; skip parts already in `completedParts`; request presigned URL and PUT for the next missing part, and continue until done or paused again.

5. **Cancel / Remove:**
   - Call backend “abort multipart” so S3 doesn’t leave incomplete uploads; then clear multipart state and dispatch the same “remove upload” as today.

### 3.4 Progress calculation

- For multipart: e.g. `progress = (number of completed parts / total_parts) * 100`, or more granular: `(sum of completed part sizes + current part loaded) / file.size * 100` if you track progress of the current part’s XHR (`upload.onprogress`).

### 3.5 UI

- Add **Pause** and **Resume** buttons (visible when `isUploading` and multipart); disable/enable based on `isPaused`.
- Optional: show “Resumed” or “Paused” label. Reuse existing progress bar and error area.

### 3.6 XHR for PUT and abort

- Use `XMLHttpRequest` with `open('PUT', presigned_url)` and `send(blob)`.
- Keep a reference to the active XHR in state (or in a ref in the View) so that on Pause you can call `xhr.abort()`.

### 3.7 Constants and store

- Add action types, e.g. `INITIATE_MULTIPART`, `MULTIPART_INITIATED`, `PART_COMPLETED`, `MULTIPART_PAUSED`, `MULTIPART_RESUMED`, `MULTIPART_COMPLETED`, `MULTIPART_ABORTED`, `MULTIPART_ERROR`.
- Add selectors for `uploadId`, `key`, `completedParts`, `isPaused`, etc., so the View and the part loop can read/write state.

---

## 4. File structure summary

| Layer | Files to add or change |
|-------|------------------------|
| Settings | `S3UPLOAD_MULTIPART_CHUNK_SIZE` (e.g. in docs/settings example); optional `S3UPLOAD_MULTIPART_ENABLED`. |
| Django views | `s3upload/views.py` — add `initiate_multipart`, `presign_part_url`, `complete_multipart`, `abort_multipart`. |
| Django utils | `s3upload/utils.py` — add multipart helpers using boto3. |
| URLs | `s3upload/urls.py` — add 4 new paths. |
| JS actions | `s3upload/src/app/actions/index.js` (and possibly new `multipart.js`) — initiate, presign, PUT part, complete, abort; pause/resume and part loop. |
| JS reducers | New reducer or extend `appStatus` for multipart state; add constants. |
| JS store/connect | Selectors for multipart state. |
| JS components | View: Pause/Resume buttons; trigger multipart vs single-upload based on file size. |
| Template | Optional: add placeholders for Pause/Resume buttons (or inject via JS). |
| Build | No change; existing `npm run build` in `s3upload/src` still produces the bundle. |

---

## 5. Testing

- **Backend:** Unit tests for new views and utils (initiate returns upload_id; presign returns URL; complete with mock parts; abort). Reuse existing dest/auth/validation tests.
- **Frontend:** Manual test: large file (> 6 MB) → start → pause → resume → complete; then submit form and check stored URL. Optional: Jest or similar for actions/reducers.
- **Integration:** Use a real S3 bucket (or LocalStack) and run through full multipart + pause/resume once.

---

## 6. Optional: Resume after page refresh

- **Constraint:** After refresh, the `File` object is gone, so the user must re-select the same file.
- **Flow:** On init (or when user selects a file), if the backend supports “resume by upload_id”:
  - Backend could store `upload_id`/`key` in session with optional metadata (e.g. filename, size). When user “resumes” (e.g. by clicking Resume and re-selecting file), frontend sends `upload_id`, `key`, and `file` (or `filename`, `size`); backend checks file matches and returns `list_parts` (from S3 ListParts) so the frontend knows which part numbers are already done and only uploads the rest.
- **Alternative:** Frontend stores `upload_id`, `key`, `filename`, `file_size` in `sessionStorage` when initiating; on page load, if such state exists, show “Resume upload for &lt;filename&gt;?” and a “Select same file” button; when file is selected and matches size/name, call a “resume_multipart” endpoint that returns upload_id + list of completed parts; then run the same part loop for missing parts only.

This can be a follow-up after the in-session pause/resume and 6 MB multipart flow are in place.

---

## 7. Implementation order (suggested)

1. **Backend:** Add multipart utils (create, presign part, complete, abort) and the four views + URLs; add minimal tests.
2. **Frontend:** Add constants, state, and actions for initiate → presign → PUT part → complete (no pause yet); wire “use multipart when file > 6 MB” and verify end-to-end upload and form submit.
3. **Frontend:** Add pause (abort current XHR, set flag) and resume (continue part loop); add Pause/Resume buttons and progress.
4. **Backend:** Tie upload_id to session (or token) and validate on presign/complete/abort.
5. **Polish:** Abort multipart on cancel/remove; error handling and i18n; optional “resume after refresh” later.

This plan gives you multipart upload with 6 MB chunks and in-session pause/resume without breaking the existing direct (presigned POST) upload path.
