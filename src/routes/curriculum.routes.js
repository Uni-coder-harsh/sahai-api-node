const express = require('express');
const router = express.Router();
const curriculumController = require('../controllers/curriculum.controller');

// Expose curriculum structure nodes and links
router.get('/:domain', curriculumController.getCurriculum);

module.exports = router;
