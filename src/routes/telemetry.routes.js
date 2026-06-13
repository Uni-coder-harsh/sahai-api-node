const express = require('express');
const router = express.Router();
const telemetryController = require('../controllers/telemetry.controller');
const { authRequired } = require('../middleware/auth');

// Buffer student telemetry events
router.post('/', authRequired, telemetryController.ingestTelemetry);

module.exports = router;
