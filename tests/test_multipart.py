"""Tests for multipart upload views and utils."""
import json
from unittest.mock import MagicMock, patch

from django.core.cache import cache
from django.test import TestCase, override_settings
from django.urls import reverse


@override_settings(S3UPLOAD_DESTINATIONS={"files": {"key": "uploads/files", "auth": lambda u: u.is_staff}})
class MultipartViewTests(TestCase):
    def setUp(self) -> None:
        from django.contrib.auth.models import User

        self.user = User.objects.create_superuser("admin", "u@email.com", "admin")
        cache.clear()

    def _initiate(self, name: str = "big.bin") -> dict:
        data = {"dest": "files", "name": name, "type": "application/octet-stream", "file_size": "7000000"}
        response = self.client.post(reverse("s3upload_initiate_multipart"), data)
        self.assertEqual(response.status_code, 200)
        return json.loads(response.content.decode())

    def _presign(self, upload: dict):
        data = {"upload_id": upload["upload_id"], "key": upload["key"], "part_number": "1"}
        return self.client.post(reverse("s3upload_presign_part_url"), data)

    def test_initiate_multipart_requires_auth(self) -> None:
        data = {"dest": "files", "name": "big.bin", "type": "application/octet-stream", "file_size": "7000000"}
        response = self.client.post(reverse("s3upload_initiate_multipart"), data)
        self.assertEqual(response.status_code, 403)

    @patch("s3upload.utils._get_s3_client")
    def test_initiate_multipart_success(self, mock_get_client: MagicMock) -> None:
        mock_s3 = MagicMock()
        mock_s3.create_multipart_upload.return_value = {"UploadId": "abc-upload-id"}
        mock_get_client.return_value = mock_s3

        self.client.login(username="admin", password="admin")
        data = {
            "dest": "files",
            "name": "big.bin",
            "type": "application/octet-stream",
            "file_size": "7000000",
        }
        response = self.client.post(reverse("s3upload_initiate_multipart"), data)
        self.assertEqual(response.status_code, 200)
        out = json.loads(response.content.decode())
        self.assertIn("upload_id", out)
        self.assertEqual(out["upload_id"], "abc-upload-id")
        self.assertIn("key", out)
        self.assertIn("part_size", out)
        self.assertIn("total_parts", out)
        self.assertEqual(out["total_parts"], 2)  # 7MB / 6MB
        self.assertIsNotNone(cache.get("s3upload:multipart:abc-upload-id"))

    def test_presign_part_url_no_session(self) -> None:
        data = {"upload_id": "x", "key": "uploads/files/big.bin", "part_number": "1"}
        response = self.client.post(reverse("s3upload_presign_part_url"), data)
        self.assertEqual(response.status_code, 403)

    @patch("s3upload.utils._get_s3_client")
    def test_presign_part_url_with_session(self, mock_get_client: MagicMock) -> None:
        mock_s3 = MagicMock()
        mock_s3.create_multipart_upload.return_value = {"UploadId": "abc-upload-id"}
        mock_s3.generate_presigned_url.return_value = "https://presigned.example/put"
        mock_get_client.return_value = mock_s3

        self.client.login(username="admin", password="admin")
        init_data = {
            "dest": "files",
            "name": "big.bin",
            "type": "application/octet-stream",
            "file_size": "7000000",
        }
        init_resp = self.client.post(reverse("s3upload_initiate_multipart"), init_data)
        self.assertEqual(init_resp.status_code, 200)
        out = json.loads(init_resp.content.decode())
        upload_id = out["upload_id"]
        key = out["key"]

        presign_data = {
            "upload_id": upload_id,
            "key": key,
            "part_number": "1",
        }
        response = self.client.post(reverse("s3upload_presign_part_url"), presign_data)
        self.assertEqual(response.status_code, 200)
        presign_out = json.loads(response.content.decode())
        self.assertEqual(presign_out["url"], "https://presigned.example/put")

    def test_abort_multipart_no_session(self) -> None:
        data = {"upload_id": "x", "key": "uploads/files/big.bin"}
        response = self.client.post(reverse("s3upload_abort_multipart"), data)
        self.assertEqual(response.status_code, 403)

    @patch("s3upload.views.abort_multipart_upload")
    @patch("s3upload.utils._get_s3_client")
    def test_abort_multipart_with_session(
        self, mock_get_client: MagicMock, mock_abort: MagicMock
    ) -> None:
        mock_s3 = MagicMock()
        mock_s3.create_multipart_upload.return_value = {"UploadId": "abc-upload-id"}
        mock_get_client.return_value = mock_s3

        self.client.login(username="admin", password="admin")
        init_data = {
            "dest": "files",
            "name": "big.bin",
            "type": "application/octet-stream",
            "file_size": "7000000",
        }
        init_resp = self.client.post(reverse("s3upload_initiate_multipart"), init_data)
        out = json.loads(init_resp.content.decode())

        abort_data = {"upload_id": out["upload_id"], "key": out["key"]}
        response = self.client.post(reverse("s3upload_abort_multipart"), abort_data)
        self.assertEqual(response.status_code, 200)
        mock_abort.assert_called_once()

    @patch("s3upload.views.complete_multipart_upload")
    @patch("s3upload.utils._get_s3_client")
    def test_complete_multipart_with_session(
        self, mock_get_client: MagicMock, mock_complete: MagicMock
    ) -> None:
        mock_s3 = MagicMock()
        mock_s3.create_multipart_upload.return_value = {"UploadId": "abc-upload-id"}
        mock_get_client.return_value = mock_s3

        self.client.login(username="admin", password="admin")
        init_data = {
            "dest": "files",
            "name": "big.bin",
            "type": "application/octet-stream",
            "file_size": "7000000",
        }
        init_resp = self.client.post(reverse("s3upload_initiate_multipart"), init_data)
        out = json.loads(init_resp.content.decode())

        complete_data = {
            "upload_id": out["upload_id"],
            "key": out["key"],
            "parts": json.dumps([{"PartNumber": 1, "ETag": "etag1"}, {"PartNumber": 2, "ETag": "etag2"}]),
        }
        response = self.client.post(
            reverse("s3upload_complete_multipart"), complete_data
        )
        self.assertEqual(response.status_code, 200)
        result = json.loads(response.content.decode())
        self.assertIn("url", result)
        mock_complete.assert_called_once()

    @patch("s3upload.utils._get_s3_client")
    def test_many_concurrent_uploads_all_stay_valid(self, mock_get_client: MagicMock) -> None:
        # The session-backed version capped this at 20 and evicted the oldest.
        mock_s3 = MagicMock()
        mock_s3.create_multipart_upload.side_effect = [{"UploadId": "id-%d" % i} for i in range(25)]
        mock_s3.generate_presigned_url.return_value = "https://presigned.example/put"
        mock_get_client.return_value = mock_s3

        self.client.login(username="admin", password="admin")
        uploads = [self._initiate("ep-%d.bin" % i) for i in range(25)]
        for upload in uploads:
            self.assertEqual(self._presign(upload).status_code, 200)

    @patch("s3upload.utils._get_s3_client")
    def test_upload_rejected_for_other_user(self, mock_get_client: MagicMock) -> None:
        from django.contrib.auth.models import User

        mock_s3 = MagicMock()
        mock_s3.create_multipart_upload.return_value = {"UploadId": "abc-upload-id"}
        mock_get_client.return_value = mock_s3

        self.client.login(username="admin", password="admin")
        upload = self._initiate()
        User.objects.create_superuser("other", "o@email.com", "other")
        self.client.login(username="other", password="other")
        self.assertEqual(self._presign(upload).status_code, 403)

    @patch("s3upload.utils._get_s3_client")
    def test_upload_rejected_for_wrong_key(self, mock_get_client: MagicMock) -> None:
        mock_s3 = MagicMock()
        mock_s3.create_multipart_upload.return_value = {"UploadId": "abc-upload-id"}
        mock_get_client.return_value = mock_s3

        self.client.login(username="admin", password="admin")
        upload = self._initiate()
        self.assertEqual(self._presign({**upload, "key": "uploads/files/other.bin"}).status_code, 403)

    @override_settings(S3UPLOAD_DESTINATIONS={"files": {"key": "uploads/files", "auth": lambda u: True}})
    @patch("s3upload.utils._get_s3_client")
    def test_anonymous_upload_tied_to_session(self, mock_get_client: MagicMock) -> None:
        mock_s3 = MagicMock()
        mock_s3.create_multipart_upload.return_value = {"UploadId": "abc-upload-id"}
        mock_s3.generate_presigned_url.return_value = "https://presigned.example/put"
        mock_get_client.return_value = mock_s3

        upload = self._initiate()
        self.assertEqual(self._presign(upload).status_code, 200)
        self.client.cookies.clear()
        self.assertEqual(self._presign(upload).status_code, 403)

    @patch("s3upload.views.complete_multipart_upload")
    @patch("s3upload.utils._get_s3_client")
    def test_complete_forgets_upload(self, mock_get_client: MagicMock, mock_complete: MagicMock) -> None:
        mock_s3 = MagicMock()
        mock_s3.create_multipart_upload.return_value = {"UploadId": "abc-upload-id"}
        mock_get_client.return_value = mock_s3

        self.client.login(username="admin", password="admin")
        upload = self._initiate()
        data = {
            "upload_id": upload["upload_id"],
            "key": upload["key"],
            "parts": json.dumps([{"PartNumber": 1, "ETag": "etag1"}]),
        }
        self.assertEqual(self.client.post(reverse("s3upload_complete_multipart"), data).status_code, 200)
        self.assertIsNone(cache.get("s3upload:multipart:abc-upload-id"))
        self.assertEqual(self._presign(upload).status_code, 403)
