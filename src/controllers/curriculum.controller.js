const pgPool = require('../database/pg');

/**
 * Retrieves the full concept graph (nodes and edges) for a given academic domain.
 * Supports returning user-personalized node mastery and correlation weights.
 */
async function getCurriculum(req, res) {
  const { domain } = req.params;
  const { user_id } = req.query;

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    let nodes = [];
    let edges = [];

    if (user_id) {
      // Fetch user-personalized cognitive state nodes
      const nodesQuery = `
        SELECT cn.node_id, cn.concept_name, cn.difficulty_baseline,
               COALESCE(ucs.expected_mastery, cn.difficulty_baseline) as expected_mastery,
               COALESCE(ucs.alpha, 2.0) as alpha,
               COALESCE(ucs.beta, 2.0) as beta
        FROM concept_nodes cn
        LEFT JOIN user_cognitive_states ucs ON cn.node_id = ucs.node_id AND ucs.user_id = $2
        WHERE cn.domain = $1
      `;
      const nodesRes = await pgPool.query(nodesQuery, [domain.toUpperCase(), user_id]);
      nodes = nodesRes.rows;

      // Fetch global correlation edges
      const edgesQuery = `
        SELECT source_node, target_node, edge_type, correlation_weight
        FROM advanced_dag_edges
        WHERE context_domain = $1
      `;
      const edgesRes = await pgPool.query(edgesQuery, [domain.toUpperCase()]);
      edges = edgesRes.rows;
    } else {
      // Fetch baseline nodes
      const nodesQuery = 'SELECT node_id, concept_name, difficulty_baseline, difficulty_baseline as expected_mastery FROM concept_nodes WHERE domain = $1';
      const nodesRes = await pgPool.query(nodesQuery, [domain.toUpperCase()]);
      nodes = nodesRes.rows;

      // Fetch prerequisite DAG link structures
      const edgesQuery = 'SELECT source_node, target_node, edge_type, correlation_weight FROM advanced_dag_edges WHERE context_domain = $1';
      const edgesRes = await pgPool.query(edgesQuery, [domain.toUpperCase()]);
      edges = edgesRes.rows;
    }

    res.json({
      domain: domain.toUpperCase(),
      nodes,
      edges
    });
  } catch (error) {
    console.error('[CurriculumController] Retrieval failed:', error);
    res.status(500).json({ error: 'Failed to retrieve curriculum structure.', details: error.message });
  }
}

module.exports = {
  getCurriculum
};
