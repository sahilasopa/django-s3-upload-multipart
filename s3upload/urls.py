from django.urls import path

from .views import (
    abort_multipart_view,
    complete_multipart_view,
    get_upload_params,
    initiate_multipart,
    presign_part_url,
)

urlpatterns = [
    path("get_upload_params/", get_upload_params, name="s3upload"),
    path("initiate_multipart/", initiate_multipart, name="s3upload_initiate_multipart"),
    path("presign_part_url/", presign_part_url, name="s3upload_presign_part_url"),
    path(
        "complete_multipart/",
        complete_multipart_view,
        name="s3upload_complete_multipart",
    ),
    path("abort_multipart/", abort_multipart_view, name="s3upload_abort_multipart"),
]
