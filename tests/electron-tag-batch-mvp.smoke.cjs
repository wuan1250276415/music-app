// Compatibility entry: persistent review supersedes the ephemeral batch UI.
// The current workflow reconciles lost preparation acknowledgements in Service.
if(!process.env.AURAL_TAG_REVIEW_UI_REPORT && process.env.AURAL_TAG_BATCH_REPORT)process.env.AURAL_TAG_REVIEW_UI_REPORT=process.env.AURAL_TAG_BATCH_REPORT;
require('./electron-tag-review-draft-mvp.smoke.cjs');
