const express = require('express');
const router = express.Router();
const pgPool = require('../database/pg');
const { getMongoDb } = require('../database/mongo');
const { authRequired } = require('../middleware/auth');

/**
 * GET /api/dashboard/student/:userId/:nodeId
 * Fetches historical Bayesian mastery snapshots for a specific user and concept node.
 */
router.get('/student/:userId/:nodeId', authRequired, async (req, res) => {
  const { userId, nodeId } = req.params;

  try {
    // 1. Fetch concept metadata from PostgreSQL
    const pgQuery = `
      SELECT node_id, concept_name, difficulty_baseline
      FROM concept_nodes
      WHERE node_id = $1;
    `;
    const pgRes = await pgPool.query(pgQuery, [nodeId]);
    const concept = pgRes.rows[0] || { node_id: nodeId, concept_name: nodeId, difficulty_baseline: 0.5 };

    // 2. Fetch time-series history from MongoDB, sorted by last_practiced ASC
    const mongoDb = getMongoDb();
    const historyDocs = await mongoDb.collection('student_cognitive_distribution')
      .find({ user_id: userId, node_id: nodeId })
      .sort({ 'temporal_factors.last_practiced': 1 })
      .toArray();

    // 3. Format snapshots for trajectory rendering
    const historyData = historyDocs.map(doc => ({
      date: doc.temporal_factors?.last_practiced || new Date().toISOString(),
      mastery: doc.temporal_factors?.current_adjusted_mastery !== undefined 
        ? doc.temporal_factors.current_adjusted_mastery 
        : 0.5,
      behavioral_flags: doc.behavioral_flags || [],
      tutor_feedback: doc.tutor_feedback || null
    }));

    // 4. Fallback if no history is recorded yet
    if (historyData.length === 0) {
      const latestDoc = await mongoDb.collection('student_cognitive_distributions')
        .findOne({ user_id: userId, node_id: nodeId });
      
      if (latestDoc) {
        historyData.push({
          date: latestDoc.temporal_factors?.last_practiced || new Date().toISOString(),
          mastery: latestDoc.temporal_factors?.current_adjusted_mastery !== undefined 
            ? latestDoc.temporal_factors.current_adjusted_mastery 
            : 0.5,
          behavioral_flags: latestDoc.behavioral_flags || [],
          tutor_feedback: latestDoc.tutor_feedback || null
        });
      } else {
        // Fallback default snapshot
        historyData.push({
          date: new Date().toISOString(),
          mastery: 0.5,
          behavioral_flags: [],
          tutor_feedback: null
        });
      }
    }

    // 5. Extract latest empathetic feedback (from history or direct query)
    let latestFeedback = null;
    for (let i = historyData.length - 1; i >= 0; i--) {
      if (historyData[i].tutor_feedback) {
        latestFeedback = historyData[i].tutor_feedback;
        break;
      }
    }

    if (!latestFeedback) {
      // Fallback query to PostgreSQL user_handwriting_responses
      const feedbackQuery = `
        SELECT llm_logical_flaw
        FROM user_handwriting_responses
        WHERE user_id = $1 AND failed_node_id = $2 AND is_correct = FALSE
        ORDER BY created_at DESC
        LIMIT 1;
      `;
      const feedbackRes = await pgPool.query(feedbackQuery, [userId, nodeId]);
      if (feedbackRes.rows.length > 0) {
        latestFeedback = {
          en: feedbackRes.rows[0].llm_logical_flaw,
          hi: feedbackRes.rows[0].llm_logical_flaw
        };
      }
    }

    res.json({
      success: true,
      concept_node: concept,
      history: historyData,
      tutor_feedback: latestFeedback
    });

  } catch (error) {
    console.error('[DashboardRoutes] Error compiling student diagnostics dashboard history:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to compile diagnostics history.', 
      details: error.message 
    });
  }
});

module.exports = router;
