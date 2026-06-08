const express = require('express');
const router = express.Router();
const telemetryController = require('../controllers/telemetry.controller');

// Buffer student telemetry events
router.post('/', telemetryController.ingestTelemetry);

module.exports = router;
