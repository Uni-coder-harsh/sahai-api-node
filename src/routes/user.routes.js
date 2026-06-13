const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { authRequired } = require('../middleware/auth');

// Auth endpoints
router.post('/signup', userController.signupUser);
router.post('/login', userController.loginUser);

// Onboarding & personalization
router.post('/', userController.onboardUser);
router.post('/:user_id/personalize', authRequired, userController.personalizeEngine);

// Retrieve cached cognitive distributions
router.get('/:user_id/cognitive-state', authRequired, userController.getCognitiveState);
router.get('/:user_id', authRequired, userController.getUserProfile);

module.exports = router;
