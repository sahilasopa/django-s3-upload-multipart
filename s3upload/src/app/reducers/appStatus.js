import constants from '../constants';

const initialMultipartState = {
    uploadId: null,
    key: null,
    partSize: null,
    totalParts: null,
    completedParts: {},
    isPaused: false,
    isMultipartUpload: false
};

export default (state = {}, action) => {
    switch (action.type) {
        case constants.BEGIN_UPLOAD_TO_AWS:
            return Object.assign({}, state, {
                isUploading: true
            });
        case constants.COMPLETE_UPLOAD_TO_AWS:
            return Object.assign({}, state, {
                isUploading: false,
                uploadProgress: 0,
                filename: action.filename,
                url: action.url
            }, initialMultipartState);
        case constants.DID_NOT_COMPLETE_UPLOAD_TO_AWS:
            return Object.assign({}, state, {
                isUploading: false
            });
        case constants.REMOVE_UPLOAD:
            return Object.assign({}, state, {
                filename: null,
                url: null
            }, initialMultipartState);
        case constants.ADD_ERROR:
            return Object.assign({}, state, {
                error: action.error
            });
        case constants.CLEAR_ERRORS:
            return Object.assign({}, state, {
                error: null
            });
        case constants.UPDATE_PROGRESS:
            return Object.assign({}, state, {
                uploadProgress: action.progress
            });
        case constants.RECEIVE_SIGNED_URL: {
            return Object.assign({}, state, {
                signedURL: action.signedURL
            });
        }
        case constants.INITIATE_MULTIPART:
            return Object.assign({}, state, {
                isUploading: true,
                isMultipartUpload: true
            });
        case constants.MULTIPART_INITIATED:
            return Object.assign({}, state, {
                uploadId: action.uploadId,
                key: action.key,
                bucket: action.bucket,
                bucket_endpoint: action.bucket_endpoint,
                partSize: action.partSize,
                totalParts: action.totalParts,
                completedParts: {},
                isPaused: false,
                isMultipartUpload: true
            });
        case constants.PART_COMPLETED: {
            const completedParts = Object.assign({}, state.completedParts || {}, {
                [action.partNumber]: { etag: action.etag }
            });
            return Object.assign({}, state, {
                completedParts
            });
        }
        case constants.MULTIPART_PAUSED:
            return Object.assign({}, state, {
                isPaused: true
            });
        case constants.MULTIPART_RESUMED:
            return Object.assign({}, state, {
                isPaused: false
            });
        case constants.MULTIPART_COMPLETED:
            return Object.assign({}, state, {
                isUploading: false,
                uploadProgress: 0
            }, initialMultipartState);
        case constants.MULTIPART_ABORTED:
        case constants.MULTIPART_ERROR:
            return Object.assign({}, state, {
                isUploading: false
            }, initialMultipartState);

        default:
            return state;
    }
}