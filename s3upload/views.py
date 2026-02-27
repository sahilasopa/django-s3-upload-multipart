from __future__ import annotations

from os.path import splitext
from typing import Any

from django.conf import settings
from django.http import HttpRequest, JsonResponse
from django.utils.text import get_valid_filename
from django.views.decorators.http import require_POST

from .utils import (
    DEFAULT_MULTIPART_CHUNK_SIZE,
    abort_multipart_upload,
    complete_multipart_upload,
    create_multipart_upload,
    create_upload_data,
    get_bucket_endpoint_url,
    get_signed_download_url,
    get_upload_part_presigned_url,
)

SESSION_KEY_MULTIPART = "s3upload_multipart"
MAX_MULTIPART_SESSION_ENTRIES = 20


def _validate_upload_dest(
    request: HttpRequest,
    dest_name: str,
    content_type: str,
    filename: str,
) -> tuple[bool, Any]:
    """
    Validate destination and permissions. Returns (True, validated_data) or
    (False, JsonResponse). validated_data has: key, bucket, acl, dest, filename,
    content_type, server_side_encryption.
    """
    try:
        dest = settings.S3UPLOAD_DESTINATIONS[dest_name]
    except KeyError:
        return False, JsonResponse(
            {"error": "File destination does not exist."}, status=400
        )

    key = dest.get("key")
    auth = dest.get("auth")
    allowed_types = dest.get("allowed_types")
    acl = dest.get("acl")
    bucket = dest.get("bucket")
    allowed_extensions = dest.get("allowed_extensions")
    server_side_encryption = dest.get("server_side_encryption")

    # Only default to public-read if acl key is missing. Use acl=None to omit ACL
    # (for buckets with "Bucket owner enforced" / ACLs disabled).
    if "acl" not in dest:
        acl = "public-read"

    if not key:
        return False, JsonResponse({"error": "Missing destination path."}, status=403)

    if auth and not auth(request.user):
        return False, JsonResponse({"error": "Permission denied."}, status=403)

    if (allowed_types and content_type not in allowed_types) and allowed_types != "*":
        return False, JsonResponse(
            {"error": "Invalid file type (%s)." % content_type}, status=400
        )

    original_ext = splitext(filename)[1]
    lowercased_ext = original_ext.lower()
    if (
        allowed_extensions and lowercased_ext not in allowed_extensions
    ) and allowed_extensions != "*":
        return False, JsonResponse(
            {"error": "Forbidden file extension (%s)." % original_ext}, status=415
        )

    if hasattr(key, "__call__"):
        key = key(filename)
    elif key == "/":
        key = filename
    else:
        key = "{}/{}".format(key, filename)

    return True, {
        "key": key,
        "bucket": bucket,
        "acl": acl,
        "dest": dest,
        "filename": filename,
        "content_type": content_type,
        "server_side_encryption": server_side_encryption,
    }


@require_POST
def get_upload_params(request: HttpRequest) -> JsonResponse:  # noqa: C901
    content_type = request.POST["type"]
    filename = get_valid_filename(request.POST["name"])
    dest_name = request.POST["dest"]

    ok, result = _validate_upload_dest(request, dest_name, content_type, filename)
    if not ok:
        return result
    key = result["key"]
    bucket = result["bucket"]
    acl = result["acl"]
    dest = result["dest"]
    content_type = result["content_type"]
    server_side_encryption = result["server_side_encryption"]
    cache_control = dest.get("cache_control")
    content_disposition = dest.get("content_disposition")
    content_length_range = dest.get("content_length_range")

    aws_payload = create_upload_data(
        content_type=content_type,
        key=key,
        acl=acl,
        bucket=bucket,
        cache_control=cache_control,
        content_disposition=content_disposition,
        content_length_range=content_length_range,
        server_side_encryption=server_side_encryption,
    )

    url = None

    # Generate signed URL for private document access
    if acl == "private":
        url = get_signed_download_url(
            key=key.replace("${filename}", result["filename"]),
            bucket_name=bucket,
            ttl=int(5 * 60),  # 5 mins
        )

    data = {
        "aws_payload": aws_payload,
        "private_access_url": url,
    }

    return JsonResponse(data, content_type="application/json")


@require_POST
def initiate_multipart(request: HttpRequest) -> JsonResponse:
    """Initiate multipart upload; store upload_id/key/bucket in session."""
    content_type = request.POST.get("type", "")
    filename = get_valid_filename(request.POST.get("name", ""))
    dest_name = request.POST.get("dest", "")
    try:
        file_size = int(request.POST.get("file_size", 0))
    except (TypeError, ValueError):
        file_size = 0

    ok, result = _validate_upload_dest(request, dest_name, content_type, filename)
    if not ok:
        return result

    key = result["key"]
    bucket = result["bucket"]
    acl = result["acl"]
    content_type = result["content_type"]
    server_side_encryption = result.get("server_side_encryption")

    part_size = getattr(
        settings,
        "S3UPLOAD_MULTIPART_CHUNK_SIZE",
        DEFAULT_MULTIPART_CHUNK_SIZE,
    )
    total_parts = max(1, (file_size + part_size - 1) // part_size) if file_size else 1

    bucket_resolved = bucket or settings.AWS_STORAGE_BUCKET_NAME

    upload_id = create_multipart_upload(
        bucket=bucket_resolved,
        key=key,
        content_type=content_type,
        acl=acl,
        server_side_encryption=server_side_encryption,
    )

    # Store by upload_id so multiple concurrent uploads (e.g. distribution videos + reels) don't overwrite each other
    entries = request.session.get(SESSION_KEY_MULTIPART)
    if isinstance(entries, dict) and "upload_id" in entries:
        # Migrate old single-entry format to keyed format
        entries = {entries["upload_id"]: {"key": entries["key"], "bucket": entries["bucket"], "acl": entries["acl"]}}
    if not isinstance(entries, dict):
        entries = {}
    entries[upload_id] = {
        "key": key,
        "bucket": bucket_resolved,
        "acl": acl,
    }
    if len(entries) > MAX_MULTIPART_SESSION_ENTRIES:
        for old_id in list(entries.keys())[: len(entries) - MAX_MULTIPART_SESSION_ENTRIES]:
            del entries[old_id]
    request.session[SESSION_KEY_MULTIPART] = entries
    request.session.save()

    bucket_endpoint = get_bucket_endpoint_url(bucket_resolved)

    return JsonResponse(
        {
            "upload_id": upload_id,
            "key": key,
            "bucket": bucket_resolved,
            "bucket_endpoint": bucket_endpoint,
            "part_size": part_size,
            "total_parts": total_parts,
        },
        content_type="application/json",
    )


def _get_session_multipart(request: HttpRequest):
    """Return session multipart dict or None; validate upload_id/key match request."""
    raw = request.session.get(SESSION_KEY_MULTIPART)
    if not raw:
        return None
    upload_id = request.POST.get("upload_id") or request.GET.get("upload_id")
    key = request.POST.get("key") or request.GET.get("key")
    if upload_id is None or key is None:
        return None
    # New format: dict keyed by upload_id
    if isinstance(raw, dict) and "upload_id" not in raw:
        entry = raw.get(upload_id)
        if not entry or str(key).strip() != str(entry.get("key") or "").strip():
            return None
        return {
            "upload_id": upload_id,
            "key": entry["key"],
            "bucket": entry["bucket"],
            "acl": entry.get("acl"),
        }
    # Old single-entry format (backward compat)
    if (
        str(upload_id).strip() != str(raw.get("upload_id") or "").strip()
        or str(key).strip() != str(raw.get("key") or "").strip()
    ):
        return None
    return raw


def _remove_session_multipart_entry(request: HttpRequest, upload_id: str) -> None:
    """Remove one upload_id from session multipart dict."""
    raw = request.session.get(SESSION_KEY_MULTIPART)
    if isinstance(raw, dict) and "upload_id" not in raw:
        entries = {k: v for k, v in raw.items() if k != upload_id}
        if not entries:
            del request.session[SESSION_KEY_MULTIPART]
        else:
            request.session[SESSION_KEY_MULTIPART] = entries
    elif isinstance(raw, dict) and raw.get("upload_id") == upload_id:
        del request.session[SESSION_KEY_MULTIPART]


@require_POST
def presign_part_url(request: HttpRequest) -> JsonResponse:
    """Return presigned PUT URL for one part."""
    session_data = _get_session_multipart(request)
    if not session_data:
        return JsonResponse(
            {"error": "Invalid or expired multipart session."}, status=403
        )
    try:
        part_number = int(request.POST.get("part_number", 0))
    except (TypeError, ValueError):
        return JsonResponse({"error": "Invalid part_number."}, status=400)
    if part_number < 1:
        return JsonResponse({"error": "Invalid part_number."}, status=400)

    url = get_upload_part_presigned_url(
        bucket=session_data["bucket"],
        key=session_data["key"],
        upload_id=session_data["upload_id"],
        part_number=part_number,
        expires_in=3600,
    )
    return JsonResponse({"url": url}, content_type="application/json")


@require_POST
def complete_multipart_view(request: HttpRequest) -> JsonResponse:
    """Complete multipart upload; return final object URL."""
    session_data = _get_session_multipart(request)
    if not session_data:
        return JsonResponse(
            {"error": "Invalid or expired multipart session."}, status=403
        )

    import json as json_module

    parts_body = request.POST.get("parts")
    if parts_body is None and request.body:
        ct = request.content_type or ""
        if "application/json" in ct:
            try:
                body = json_module.loads(request.body.decode("utf-8"))
                parts_body = body.get("parts")
                if parts_body is not None:
                    parts_body = json_module.dumps(parts_body)
            except (TypeError, ValueError, UnicodeDecodeError):
                pass
    if parts_body is None:
        return JsonResponse({"error": "Missing parts."}, status=400)
    if isinstance(parts_body, bytes):
        parts_body = parts_body.decode("utf-8")
    try:
        parts = (
            json_module.loads(parts_body)
            if isinstance(parts_body, str)
            else parts_body
        )
    except (TypeError, ValueError):
        return JsonResponse({"error": "Invalid parts JSON."}, status=400)

    if not isinstance(parts, list):
        return JsonResponse({"error": "parts must be a list."}, status=400)

    # Normalize: S3 expects PartNumber and ETag (ETag with quotes)
    normalized = []
    for p in parts:
        part_num = p.get("PartNumber") or p.get("part_number")
        etag = p.get("ETag") or p.get("etag") or ""
        if not etag.startswith('"'):
            etag = '"' + etag + '"'
        normalized.append({"PartNumber": int(part_num), "ETag": etag})

    try:
        complete_multipart_upload(
            bucket=session_data["bucket"],
            key=session_data["key"],
            upload_id=session_data["upload_id"],
            parts=normalized,
        )
    except Exception as e:
        return JsonResponse(
            {"error": "Failed to complete upload: %s" % str(e)}, status=500
        )

    # Remove this upload from session (keep other concurrent uploads)
    _remove_session_multipart_entry(request, session_data["upload_id"])

    key = session_data["key"]
    bucket = session_data["bucket"]
    bucket_endpoint = get_bucket_endpoint_url(bucket)
    url = "%s/%s" % (bucket_endpoint.rstrip("/"), key.lstrip("/"))

    private_access_url = None
    if session_data.get("acl") == "private":
        private_access_url = get_signed_download_url(
            key=key, bucket_name=bucket, ttl=5 * 60
        )

    return JsonResponse(
        {"url": url, "private_access_url": private_access_url},
        content_type="application/json",
    )


@require_POST
def abort_multipart_view(request: HttpRequest) -> JsonResponse:
    """Abort multipart upload and clear session."""
    session_data = _get_session_multipart(request)
    if not session_data:
        return JsonResponse(
            {"error": "Invalid or expired multipart session."}, status=403
        )
    try:
        abort_multipart_upload(
            bucket=session_data["bucket"],
            key=session_data["key"],
            upload_id=session_data["upload_id"],
        )
    except Exception:
        pass
    _remove_session_multipart_entry(request, session_data["upload_id"])
    return JsonResponse({}, content_type="application/json")
