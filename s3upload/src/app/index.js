import configureStore from './store';
import {View} from './components';

// by default initHandler inits on '.s3upload', but if passed a custom
// selector in the event data, it will init on that instead.
// Skip elements already initialized (avoids double-init when script is loaded twice).
const S3UPLOAD_INIT_ATTR = 'data-s3upload-initialized';

function initHandler(event) {
    let selector = '.s3upload';

    if (event.detail && event.detail.selector) {
        selector = event.detail.selector;
    }

    const elements = document.querySelectorAll(selector);

    // safari doesn't like forEach on nodeList objects
    for (let i = 0; i < elements.length; i++) {
        const element = elements[i];
        if (element.getAttribute(S3UPLOAD_INIT_ATTR) === 'true') continue;
        const store = configureStore({element});
        const view = new View(element, store);
        view.init();
        element.setAttribute(S3UPLOAD_INIT_ATTR, 'true');
    }
}

// default global init on document ready
document.addEventListener('DOMContentLoaded', initHandler);

// custom event listener for use in async init
document.addEventListener('s3upload:init', initHandler);