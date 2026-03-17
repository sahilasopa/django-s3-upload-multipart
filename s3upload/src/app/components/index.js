import {removeUpload, getUploadURL, clearErrors, updateProgress, multipartPaused, multipartResumed, abortMultipartAndRemove} from '../actions';
import {getFilename, getUrl, getError, getUploadProgress, getMultipartState} from '../store';
import {observeStore, raiseEvent} from '../utils';


const View = function(element, store) {
    return {
        renderFilename: function() {
            const filename = getFilename(store),
                url = getUrl(store);

            if (filename && url) {
                this.$link.innerHTML = filename;
                this.$link.setAttribute('href', url);
                this.$url.value = url.split("?")[0];

                this.$element.classList.add('link-active');
                this.$element.classList.remove('form-active');
            }
            else {
                this.$url.value = '';
                this.$input.value = '';

                this.$element.classList.add('form-active');
                this.$element.classList.remove('link-active');
            }
        },

        renderError: function() {
            const error = getError(store);

            if (error) {
                this.$element.classList.add('has-error');
                this.$element.classList.add('form-active');
                this.$element.classList.remove('link-active');

                this.$element.querySelector('.s3upload__file-input').value = '';
                this.$element.querySelector('.s3upload__error').innerHTML = error;
            }
            else {
                this.$element.classList.remove('has-error');
                this.$element.querySelector('.s3upload__error').innerHTML = '';
            }
        },

        renderUploadProgress: function() {
            const uploadProgress = getUploadProgress(store);

            if (uploadProgress > 0) {
                this.$element.classList.add('progress-active');
                this.$bar.style.width = uploadProgress + '%';
            }
            else {
                this.$element.classList.remove('progress-active');
                this.$bar.style.width = '0';
            }
        },

        removeUpload: function(event) {
            event.preventDefault();
            var self = this;
            var policyUrl = this.$element.getAttribute('data-policy-url');
            function clearUpload() {
                store.dispatch(updateProgress());
                store.dispatch(removeUpload());
                self.$input.value = '';
                self.$element.classList.add('form-active');
                self.$element.classList.remove('link-active');
                raiseEvent(self.$element, 's3upload:clear-upload');
            }
            abortMultipartAndRemove(store, policyUrl, clearUpload);
        },

        getUploadURL: function(event) {
            const file = this.$input.files[0];
            if (!file) return;
            // Prevent double-start: if a multipart upload is already in progress, ignore
            const state = store.getState().appStatus;
            if (state.isUploading && state.isMultipartUpload) return;
            const dest = this.$dest.value,
                url  = this.$element.getAttribute('data-policy-url');

            store.dispatch(clearErrors());
            store.dispatch(getUploadURL(file, dest, url, store, this.xhrRef, this.resumeRef));
        },

        pauseUpload: function(event) {
            event.preventDefault();
            if (this.xhrRef && this.xhrRef.xhr) {
                this.xhrRef.pausedByUser = true;
                this.xhrRef.xhr.abort();
                this.xhrRef.xhr = null;
            }
            store.dispatch(multipartPaused());
        },

        resumeUpload: function(event) {
            event.preventDefault();
            store.dispatch(multipartResumed());
            if (this.resumeRef && typeof this.resumeRef.resume === 'function') {
                this.resumeRef.resume();
            }
        },

        cancelUpload: function(event) {
            event.preventDefault();
            if (this.xhrRef && this.xhrRef.xhr) {
                this.xhrRef.pausedByUser = true;
                this.xhrRef.xhr.abort();
                this.xhrRef.xhr = null;
            }
            var self = this;
            var policyUrl = this.$element.getAttribute('data-policy-url');
            function clearUpload() {
                store.dispatch(updateProgress());
                store.dispatch(removeUpload());
                self.$input.value = '';
                self.$element.classList.add('form-active');
                self.$element.classList.remove('link-active');
                raiseEvent(self.$element, 's3upload:clear-upload');
            }
            abortMultipartAndRemove(store, policyUrl, clearUpload);
        },

        renderMultipartControls: function() {
            const state = getMultipartState(store);
            const controls = this.$multipartControls;
            const pauseBtn = this.$pauseBtn;
            const resumeBtn = this.$resumeBtn;
            if (!controls || !pauseBtn || !resumeBtn) return;
            if (state.isMultipartUpload && store.getState().appStatus.isUploading) {
                controls.style.display = 'flex';
                pauseBtn.style.display = state.isPaused ? 'none' : 'inline-flex';
                resumeBtn.style.display = state.isPaused ? 'inline-flex' : 'none';
            } else {
                controls.style.display = 'none';
            }
        },

        init: function() {
            // cache all the query selectors
            // $variables represent DOM elements
            this.$element = element;
            this.$url     = element.querySelector('.s3upload__file-url');
            this.$input   = element.querySelector('.s3upload__file-input');
            this.$remove  = element.querySelector('.s3upload__file-remove');
            this.$dest    = element.querySelector('.s3upload__file-dest');
            this.$link    = element.querySelector('.s3upload__file-link');
            this.$error   = element.querySelector('.s3upload__error');
            this.$bar     = element.querySelector('.s3upload__bar');
            this.$multipartControls = element.querySelector('.s3upload__multipart-controls');
            this.$pauseBtn = element.querySelector('.s3upload__pause');
            this.$resumeBtn = element.querySelector('.s3upload__resume');
            this.$cancelBtn = element.querySelector('.s3upload__cancel');
            this.xhrRef = { xhr: null };
            this.resumeRef = { resume: null };

            // set initial DOM states3upload__
            const status = (this.$url.value === '') ? 'form' : 'link';
            this.$element.classList.add(status + '-active');

            // add event listeners
            this.$remove.addEventListener('click', this.removeUpload.bind(this))
            this.$input.addEventListener('change', this.getUploadURL.bind(this))
            if (this.$pauseBtn) this.$pauseBtn.addEventListener('click', this.pauseUpload.bind(this));
            if (this.$resumeBtn) this.$resumeBtn.addEventListener('click', this.resumeUpload.bind(this));
            if (this.$cancelBtn) this.$cancelBtn.addEventListener('click', this.cancelUpload.bind(this));

            // these observers subscribe to the store
            const filenameObserver = observeStore(store, state => state.appStatus.filename, this.renderFilename.bind(this));
            const errorObserver = observeStore(store, state => state.appStatus.error, this.renderError.bind(this));
            const uploadProgressObserver = observeStore(store, state => state.appStatus.uploadProgress, this.renderUploadProgress.bind(this));
            const multipartObserver = observeStore(store, state =>
                (state.appStatus.isMultipartUpload && state.appStatus.isUploading) ? (state.appStatus.isPaused ? 'paused' : 'uploading') : 'hidden',
                this.renderMultipartControls.bind(this)
            );
            // Disable file input while multipart upload is in progress to prevent double trigger
            observeStore(store, state => state.appStatus.isUploading && state.appStatus.isMultipartUpload, (isUploading) => {
                if (this.$input) this.$input.disabled = !!isUploading;
            });
        }
    }
}

export {View};