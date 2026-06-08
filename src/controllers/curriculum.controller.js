const pgPool = require('../database/pg');

/**
 * Retrieves the full concept graph (nodes and edges) for a given academic domain.
 */
async function getCurriculum(req, res) {
  const { domain } = req.params;

  try {
    // Fetch nodes
    const nodesQuery = 'SELECT node_id, concept_name, difficulty_baseline FROM concept_nodes WHERE domain = $1';
    const nodesRes = await pgPool.query(nodesQuery, [domain.toUpperCase()]);

    // Fetch prerequisite DAG link structures
    const edgesQuery = 'SELECT source_node, target_node, edge_type, correlation_weight FROM advanced_dag_edges WHERE context_domain = $1';
    const edgesRes = await pgPool.query(edgesQuery, [domain.toUpperCase()]);

    res.json({
      domain: domain.toUpperCase(),
      nodes: nodesRes.rows,
      edges: edgesRes.rows
    });
  } catch (error) {
    console.error('[CurriculumController] Retrieval failed:', error);
    res.status(500).json({ error: 'Failed to retrieve curriculum structure.', details: error.message });
  }
}

module.exports = {
  getCurriculum
};
