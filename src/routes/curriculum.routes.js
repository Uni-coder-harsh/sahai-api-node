const express = require('express');
const router = express.Router();
const curriculumController = require('../controllers/curriculum.controller');
const { authRequired } = require('../middleware/auth');

// Expose curriculum structure nodes and links
router.get('/:domain', authRequired, curriculumController.getCurriculum);

module.exports = router;
