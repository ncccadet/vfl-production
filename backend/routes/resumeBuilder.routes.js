// resumeBuilder.routes.js
//
// No daily limit on this feature (explicit founder decision — see
// _contracts/07-resume-builder.md "Daily AI Limit"). Unlike every other AI
// feature in this codebase, /build carries no featureLimit middleware.
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { getTemplates, saveDraft, getDraft, buildResume, getBuildResult, getResume, getPhotoUploadUrl, enhanceAll, enhanceText } = require('../controllers/resumeBuilder.controller');

router.get('/templates',         authMiddleware, getTemplates);
router.get('/photo-upload-url',  authMiddleware, getPhotoUploadUrl);
router.post('/draft',            authMiddleware, saveDraft);
router.get('/draft',             authMiddleware, getDraft);
router.post('/build',            authMiddleware, buildResume);
router.post('/enhance-all',      authMiddleware, enhanceAll);    // rewrite EVERY free-text field at once, writes back into the form; no daily limit
router.post('/enhance',          authMiddleware, enhanceText);   // per-field AI rewrite — same no-daily-limit policy; input/output tightly capped in controller
router.get('/result/:buildId',   authMiddleware, getBuildResult);
router.get('/download',          authMiddleware, getResume);

module.exports = router;
