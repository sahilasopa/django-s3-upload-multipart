import constants from '../constants';
import {i18n_strings} from '../constants';
import {request, putRequest, parseJson, getCookie, parseURL, parseNameFromUrl, raiseEvent} from '../utils';
import {getElement, getAWSPayload, getMultipartState} from '../store';

var MULTIPART_CHUNK_SIZE = 5 * 1024 * 1024;

function getMultipartBaseUrl(policyUrl) {
    return policyUrl.replace(/get_upload_params\/?$/, '');
}

export const getUploadURL = (file, dest, url, store, xhrRef, resumeRef) => {

    if (file.size > MULTIPART_CHUNK_SIZE) {
        store.dispatch(initiateMultipart(file, dest, url, store, xhrRef, resumeRef));
        return { type: constants.INITIATE_MULTIPART };
    }

    const form  = new FormData(),
        headers = {'X-CSRFToken': getCookie('csrftoken')};

    form.append('type', file.type);
    form.append('name', file.name);
    form.append('dest', dest);

    const onLoad = function(status, json) {
        const data = parseJson(json);

        switch(status) {
            case 200:
                store.dispatch(receiveSignedURL(data.private_access_url));
                store.dispatch(receiveAWSUploadParams(data.aws_payload));
                store.dispatch(beginUploadToAWS(file, store));
                break;
            case 400:
            case 403:
            case 415:
                console.error('Error uploading', status, data.error);
                raiseEvent(getElement(store), 's3upload:error', {status, error: data});
                store.dispatch(addError(data.error));
                store.dispatch(didNotReceivAWSUploadParams());
                break;
            default:
                console.error('Error uploading', status, i18n_strings.no_upload_url);
                raiseEvent(getElement(store), 's3upload:error', {status, error: data});
                store.dispatch(addError(i18n_strings.no_upload_url));
                store.dispatch(didNotReceivAWSUploadParams());
        }
    }

    const onError = function(status, json) {
        const data = parseJson(json);

        console.error('Error uploading', status, i18n_strings.no_upload_url);
        raiseEvent(getElement(store), 's3upload:error', {status, error: data});

        store.dispatch(addError(i18n_strings.no_upload_url));
    }

    request('POST', url, form, headers, false, onLoad, onError);

    return {
        type: constants.REQUEST_AWS_UPLOAD_PARAMS
    }
}

export const initiateMultipart = (file, dest, policyUrl, store, xhrRef, resumeRef) => {
    const baseUrl = getMultipartBaseUrl(policyUrl);
    const initiateUrl = baseUrl + (baseUrl.indexOf('?') >= 0 ? '&' : '') + 'initiate_multipart/';
    var form = new FormData();
    form.append('type', file.type);
    form.append('name', file.name);
    form.append('dest', dest);
    form.append('file_size', String(file.size));
    var headers = { 'X-CSRFToken': getCookie('csrftoken') };

    var onLoad = function(status, json) {
        var data = parseJson(json);
        if (status !== 200) {
            store.dispatch(addError(data && data.error ? data.error : i18n_strings.no_multipart_init_failed));
            store.dispatch(multipartError());
            raiseEvent(getElement(store), 's3upload:error', { status: status, error: data });
            return;
        }
        store.dispatch(multipartInitiated(data));
        runMultipartPartLoop(file, store, baseUrl, xhrRef, resumeRef);
    };
    var onError = function(status, json) {
        store.dispatch(addError(i18n_strings.no_multipart_init_failed));
        store.dispatch(multipartError());
        raiseEvent(getElement(store), 's3upload:error', { status: status, error: parseJson(json) });
    };
    request('POST', initiateUrl, form, headers, false, onLoad, onError);
    return { type: constants.INITIATE_MULTIPART };
};

export const multipartInitiated = (data) => ({
    type: constants.MULTIPART_INITIATED,
    uploadId: data.upload_id,
    key: data.key,
    bucket: data.bucket,
    bucket_endpoint: data.bucket_endpoint,
    partSize: data.part_size,
    totalParts: data.total_parts
});

function runMultipartPartLoop(file, store, baseUrl, xhrRef, resumeRef) {
    var presignUrl = baseUrl + (baseUrl.indexOf('?') >= 0 ? '&' : '') + 'presign_part_url/';
    var completeUrl = baseUrl + (baseUrl.indexOf('?') >= 0 ? '&' : '') + 'complete_multipart/';
    var headers = { 'X-CSRFToken': getCookie('csrftoken') };

    function doPart(partNumber) {
        var state = getMultipartState(store);
        if (partNumber > state.totalParts) {
            return sendComplete(store, completeUrl, headers, file.name);
        }
        if (state.isPaused) return;
        if (state.completedParts[partNumber]) return doPart(partNumber + 1);

        var form = new FormData();
        form.append('upload_id', state.uploadId);
        form.append('key', state.key);
        form.append('part_number', String(partNumber));

        request('POST', presignUrl, form, headers, false, function(status, json) {
            if (status !== 200) {
                store.dispatch(addError(i18n_strings.no_multipart_failed));
                store.dispatch(multipartError());
                return;
            }
            var data = parseJson(json);
            var putUrl = data && data.url;
            if (!putUrl) {
                store.dispatch(addError(i18n_strings.no_multipart_failed));
                store.dispatch(multipartError());
                return;
            }
            var start = (partNumber - 1) * state.partSize;
            var end = partNumber * state.partSize;
            if (end > file.size) end = file.size;
            var chunk = file.slice(start, end);

            var xhr = putRequest(putUrl, chunk,
                function(progressData) {
                    if (progressData.lengthComputable) {
                        var partProgress = Math.round(progressData.loaded * 100 / progressData.total);
                        var completedCount = Object.keys(state.completedParts || {}).length;
                        var total = state.totalParts;
                        var progress = Math.round((completedCount / total) * 100 + (partProgress / total));
                        store.dispatch(updateProgress(progress));
                        raiseEvent(getElement(store), 's3upload:progress-updated', { progress: progress });
                    }
                },
                function(statusCode, responseText, xhrObj) {
                    if (xhrRef) xhrRef.xhr = null;
                    if (statusCode !== 200) {
                        store.dispatch(addError(i18n_strings.no_multipart_failed));
                        store.dispatch(multipartError());
                        return;
                    }
                    var etag = xhrObj.getResponseHeader('ETag');
                    if (etag) etag = etag.replace(/^"|"$/g, '');
                    store.dispatch(partCompleted(partNumber, etag || ''));
                    var completed = (store.getState().appStatus.completedParts || {});
                    var completedCount = Object.keys(completed).length;
                    store.dispatch(updateProgress(Math.round((completedCount / state.totalParts) * 100)));
                    raiseEvent(getElement(store), 's3upload:progress-updated', { progress: Math.round((completedCount / state.totalParts) * 100) });
                    doPart(partNumber + 1);
                },
                function(statusCode, responseText) {
                    if (xhrRef) {
                        xhrRef.xhr = null;
                        if (xhrRef.pausedByUser) {
                            xhrRef.pausedByUser = false;
                            return;
                        }
                    }
                    if (store.getState().appStatus.isPaused) return;
                    store.dispatch(addError(i18n_strings.no_multipart_failed));
                    store.dispatch(multipartError());
                }
            );
            if (xhrRef) xhrRef.xhr = xhr;
        }, function(status, json) {
            store.dispatch(addError(i18n_strings.no_multipart_failed));
            store.dispatch(multipartError());
        });
    }

    if (resumeRef) resumeRef.resume = function() { doPart(1); };
    doPart(1);
}

function sendComplete(store, completeUrl, headers, filename) {
    var state = getMultipartState(store);
    var parts = [];
    var completedParts = state.completedParts || {};
    for (var i = 1; i <= state.totalParts; i++) {
        if (completedParts[i] && completedParts[i].etag) {
            parts.push({ PartNumber: i, ETag: completedParts[i].etag });
        }
    }
    if (parts.length !== state.totalParts) {
        store.dispatch(addError(i18n_strings.no_multipart_failed));
        store.dispatch(multipartError());
        return;
    }
    var form = new FormData();
    form.append('upload_id', state.uploadId);
    form.append('key', state.key);
    form.append('parts', JSON.stringify(parts));

    request('POST', completeUrl, form, headers, false, function(status, json) {
        if (status !== 200) {
            store.dispatch(addError(i18n_strings.no_multipart_failed));
            store.dispatch(multipartError());
            return;
        }
        var data = parseJson(json);
        var url = data && (data.private_access_url || data.url);
        if (!url) {
            store.dispatch(addError(i18n_strings.no_multipart_failed));
            store.dispatch(multipartError());
            return;
        }
        store.dispatch(multipartCompleted());
        store.dispatch(completeUploadToAWS(filename, url));
        raiseEvent(getElement(store), 's3upload:file-uploaded', { filename: filename, url: url });
    }, function(status, json) {
        store.dispatch(addError(i18n_strings.no_multipart_failed));
        store.dispatch(multipartError());
    });
}

export const partCompleted = (partNumber, etag) => ({
    type: constants.PART_COMPLETED,
    partNumber: partNumber,
    etag: etag
});

export const multipartPaused = () => ({ type: constants.MULTIPART_PAUSED });
export const multipartResumed = () => ({ type: constants.MULTIPART_RESUMED });

export const multipartCompleted = () => ({ type: constants.MULTIPART_COMPLETED });
export const multipartAborted = () => ({ type: constants.MULTIPART_ABORTED });
export const multipartError = () => ({ type: constants.MULTIPART_ERROR });

/**
 * If a multipart upload is in progress, POST to abort_multipart then call onDone.
 * Otherwise call onDone immediately.
 */
export function abortMultipartAndRemove(store, policyUrl, onDone) {
    var state = getMultipartState(store);
    if (!state.uploadId || !state.key) {
        onDone();
        return;
    }
    var baseUrl = getMultipartBaseUrl(policyUrl);
    var abortUrl = baseUrl + (baseUrl.indexOf('?') >= 0 ? '&' : '') + 'abort_multipart/';
    var form = new FormData();
    form.append('upload_id', state.uploadId);
    form.append('key', state.key);
    var headers = { 'X-CSRFToken': getCookie('csrftoken') };
    request('POST', abortUrl, form, headers, false, onDone, onDone);
}

export const receiveAWSUploadParams = (aws_payload) => {
    return {
        type: constants.RECEIVE_AWS_UPLOAD_PARAMS,
        aws_payload: aws_payload
    }
}

export const receiveSignedURL = (signedURL) => {
    return {
        type: constants.RECEIVE_SIGNED_URL,
        signedURL,
    }
}

export const didNotReceivAWSUploadParams = () => {
    return {
        type: constants.DID_NOT_RECEIVE_AWS_UPLOAD_PARAMS,
    }
}

export const removeUpload = () => {
    return {
        type: constants.REMOVE_UPLOAD
    }
}

export const beginUploadToAWS = (file, store) => {
    const AWSPayload = getAWSPayload(store),
        url = AWSPayload.form_action,
        headers = {};

    let form = new FormData();

    // we need to remove this key because otherwise S3 will trigger a 403
    // when we send the payload along with the file.
    delete AWSPayload['form_action'];

    Object.keys(AWSPayload).forEach(function(key){
        form.append(key, AWSPayload[key]);
    });

    // the file has to be appended at the end, or else S3 will throw a wobbly
    form.append('file', file);

    const onLoad = function(status, xml) {
        switch(status) {
            case 201:
                const url = parseURL(xml),
                    filename = parseNameFromUrl(url).split('/').pop();

                store.dispatch(completeUploadToAWS(filename, url));
                raiseEvent(getElement(store), 's3upload:file-uploaded', {filename, url});
                break;
            default:
                console.error('Error uploading', status, xml);
                raiseEvent(getElement(store), 's3upload:error', {status, error: xml});

                store.dispatch(didNotCompleteUploadToAWS());

                if (xml.indexOf('<MinSizeAllowed>') > -1) {
                    store.dispatch(addError(i18n_strings.no_file_too_small));
                }
                else if (xml.indexOf('<MaxSizeAllowed>') > -1) {
                    store.dispatch(addError(i18n_strings.no_file_too_large));
                }
                else {
                    store.dispatch(addError(i18n_strings.no_upload_failed));
                }

                break;
        }
    };

    const onError = function(status, xml) {
        console.error('Error uploading', status, xml);
        raiseEvent(getElement(store), 's3upload:error', {status, xml});

        store.dispatch(didNotCompleteUploadToAWS());
        store.dispatch(addError(i18n_strings.no_upload_failed));
    }

    const onProgress = function(data) {
        let progress = null;

        if (data.lengthComputable) {
            progress = Math.round(data.loaded * 100 / data.total);
        }

        store.dispatch(updateProgress(progress));
        raiseEvent(getElement(store), 's3upload:progress-updated', {progress});
    }

    request('POST', url, form, headers, onProgress, onLoad, onError);

    return {
        type: constants.BEGIN_UPLOAD_TO_AWS
    }
}

export const completeUploadToAWS = (filename, url) => {
    return {
        type: constants.COMPLETE_UPLOAD_TO_AWS,
        url,
        filename
    }
}

export const didNotCompleteUploadToAWS = () => {
    return {
        type: constants.DID_NOT_COMPLETE_UPLOAD_TO_AWS
    }
}

export const addError = (error) => {
    return {
        type: constants.ADD_ERROR,
        error
    }
}

export const clearErrors = () => {
    return {
        type: constants.CLEAR_ERRORS
    }
}

export const updateProgress = (progress = {}) => {
    return {
        type: constants.UPDATE_PROGRESS,
        progress
    }
}
