const express = require('express');
const router = express.Router();
const telemetryController = require('../controllers/telemetry.controller');
const { authRequired } = require('../middleware/auth');
const { telemetryRateLimiter } = require('../middleware/rateLimiter');
const { decryptTelemetry } = require('../middleware/decrypt');

// Buffer student telemetry events with a 3-layer security perimeter:
// 1. JWT Authentication (populates req.userId)
// 2. Redis-Backed Rate Limiting (5-second window per user)
// 3. Zero-Trust AES Decryption (decrypts req.body)
router.post(
  '/', 
  authRequired, 
  telemetryRateLimiter, 
  decryptTelemetry, 
  telemetryController.ingestTelemetry
);

module.exports = router;
