const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');

// Create user and bootstrap cognitive priorities
router.post('/', userController.onboardUser);

// Retrieve cached cognitive distributions
router.get('/:user_id/cognitive-state', userController.getCognitiveState);

module.exports = router;
