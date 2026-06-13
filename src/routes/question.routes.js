const express = require('express');
const router = express.Router();
const questionController = require('../controllers/question.controller');
const { authRequired } = require('../middleware/auth');

// Retrieve diagnostic questions for the initial test
router.get('/initial', authRequired, questionController.getInitialQuestions);

// Retrieve personalized practice questions
router.get('/practice', authRequired, questionController.getPracticeQuestions);

// Submit answers and trigger Bayesian updates
router.post('/submit', authRequired, questionController.submitAnswer);

module.exports = router;
