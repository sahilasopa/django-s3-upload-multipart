<div class="s3upload" data-policy-url="{{ policy_url }}">
    <a class="s3upload__file-link" target="_blank" href="{{ file_url }}">{{ file_name }}</a>
    <a class="s3upload__file-remove" href="#remove">Remove</a>
    <input
        class="s3upload__file-url"
        type="hidden"
        value="{{ file_url }}"
        id="{{ element_id }}"
        name="{{ name }}"
    />
    <input class="s3upload__file-dest" type="hidden" value="{{ dest }}" />
    <input class="s3upload__file-input" type="file" style="{{ style }}" />
    <div class="s3upload__error"></div>
    <div class="s3upload__progress-row">
        <div class="s3upload__progress active">
            <div class="s3upload__bar"></div>
        </div>
        <div class="s3upload__multipart-controls" style="display: none;">
            <button type="button" class="s3upload__icon-btn s3upload__pause" aria-label="Pause upload" title="Pause">
                <svg class="s3upload__icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            </button>
            <button type="button" class="s3upload__icon-btn s3upload__resume" style="display: none;" aria-label="Resume upload" title="Resume">
                <svg class="s3upload__icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
            </button>
            <button type="button" class="s3upload__icon-btn s3upload__cancel" aria-label="Cancel upload" title="Cancel">
                <svg class="s3upload__icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
        </div>
    </div>
</div>
