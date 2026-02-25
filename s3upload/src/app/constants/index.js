export default {
    REQUEST_AWS_UPLOAD_PARAMS: 'REQUEST_AWS_UPLOAD_PARAMS',
    RECEIVE_AWS_UPLOAD_PARAMS: 'RECEIVE_AWS_UPLOAD_PARAMS',
    DID_NOT_RECEIVE_AWS_UPLOAD_PARAMS: 'DID_NOT_RECEIVE_AWS_UPLOAD_PARAMS',
    REMOVE_UPLOAD: 'REMOVE_UPLOAD',
    BEGIN_UPLOAD_TO_AWS: 'BEGIN_UPLOAD_TO_AWS',
    COMPLETE_UPLOAD_TO_AWS: 'COMPLETE_UPLOAD_TO_AWS',
    DID_NOT_COMPLETE_UPLOAD_TO_AWS: 'DID_NOT_COMPLETE_UPLOAD_TO_AWS',
    ADD_ERROR: 'ADD_ERROR',
    CLEAR_ERRORS: 'CLEAR_ERRORS',
    UPDATE_PROGRESS: 'UPDATE_PROGRESS',
    RECEIVE_SIGNED_URL: 'RECEIVE_SIGNED_URL',
    INITIATE_MULTIPART: 'INITIATE_MULTIPART',
    MULTIPART_INITIATED: 'MULTIPART_INITIATED',
    PART_COMPLETED: 'PART_COMPLETED',
    MULTIPART_PAUSED: 'MULTIPART_PAUSED',
    MULTIPART_RESUMED: 'MULTIPART_RESUMED',
    MULTIPART_COMPLETED: 'MULTIPART_COMPLETED',
    MULTIPART_ABORTED: 'MULTIPART_ABORTED',
    MULTIPART_ERROR: 'MULTIPART_ERROR'
};

let i18n_strings;

try {
    i18n_strings = djangoS3Upload.i18n_strings;
} catch(e) {
    i18n_strings = {
        "no_upload_failed": "Sorry, failed to upload file.",
        "no_upload_url": "Sorry, could not get upload URL.",
        "no_file_too_large": "Sorry, the file is too large to be uploaded.",
        "no_file_too_small": "Sorry, the file is too small to be uploaded.",
        "no_multipart_init_failed": "Sorry, could not start multipart upload.",
        "no_multipart_failed": "Sorry, multipart upload failed."
    };
}

export {i18n_strings};