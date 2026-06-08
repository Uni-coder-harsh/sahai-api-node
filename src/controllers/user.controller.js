const pgPool = require('../database/pg');

/**
 * Onboards a user and initializes cognitive prior states for their academic domain.
 */
async function onboardUser(req, res) {
  const {
    sso_email,
    phone_number,
    academic_stream,
    current_semester,
    graduation_year,
    current_cgpa,
    state_of_residence,
    primary_language,
    institution_id,
    device_signature
  } = req.body;

  if (!sso_email || !academic_stream) {
    return res.status(400).json({ error: 'SSO Email and Academic Stream are required.' });
  }

  // Determine domain context (e.g. 'CS', 'LAW', 'ARTS')
  let domain = 'CS';
  if (academic_stream.toLowerCase().includes('law')) {
    domain = 'LAW';
  } else if (academic_stream.toLowerCase().includes('arts')) {
    domain = 'ARTS';
  }

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    // Insert user profile
    const userQuery = `
      INSERT INTO users (
        institution_id, sso_email, phone_number, academic_stream,
        current_semester, graduation_year, current_cgpa,
        state_of_residence, primary_language, device_signature
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, sso_email, academic_stream;
    `;
    const userVal = [
      institution_id || null, sso_email, phone_number || null, academic_stream,
      current_semester || 1, graduation_year || 2027, current_cgpa || null,
      state_of_residence || null, primary_language || 'en', JSON.stringify(device_signature || {})
    ];
    
    const userRes = await client.query(userQuery, userVal);
    const user = userRes.rows[0];

    // Fetch syllabus concept nodes to bootstrap belief state
    const conceptsRes = await client.query(
      'SELECT node_id FROM concept_nodes WHERE domain = $1',
      [domain]
    );

    if (conceptsRes.rows.length > 0) {
      const stateQueries = conceptsRes.rows.map(concept => {
        return client.query(`
          INSERT INTO user_cognitive_states (user_id, node_id, alpha, beta, expected_mastery)
          VALUES ($1, $2, 1.0, 1.0, 0.5000)
          ON CONFLICT (user_id, node_id) DO NOTHING;
        `, [user.id, concept.node_id]);
      });
      await Promise.all(stateQueries);
    }

    await client.query('COMMIT');
    res.status(201).json({
      message: 'User profile created and cognitive state initialized.',
      user: {
        id: user.id,
        email: user.sso_email,
        stream: user.academic_stream,
        domain
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[UserController] Onboarding failed:', error);
    res.status(500).json({ error: 'Failed to onboard user.', details: error.message });
  } finally {
    client.release();
  }
}

/**
 * Retrieves the current student cognitive state mesh from the SQL cache.
 */
async function getCognitiveState(req, res) {
  const { user_id } = req.params;

  try {
    const stateQuery = `
      SELECT ucs.node_id, cn.concept_name, cn.difficulty_baseline, 
             ucs.alpha, ucs.beta, ucs.expected_mastery, ucs.last_practiced
      FROM user_cognitive_states ucs
      JOIN concept_nodes cn ON ucs.node_id = cn.node_id
      WHERE ucs.user_id = $1
      ORDER BY ucs.expected_mastery DESC;
    `;
    const stateRes = await pgPool.query(stateQuery, [user_id]);

    if (stateRes.rows.length === 0) {
      return res.status(404).json({ error: 'Cognitive state not found for user.' });
    }

    res.json({
      user_id,
      cognitive_state: stateRes.rows
    });
  } catch (error) {
    console.error('[UserController] Failed to retrieve cognitive state:', error);
    res.status(500).json({ error: 'Failed to retrieve cognitive state.', details: error.message });
  }
}

module.exports = {
  onboardUser,
  getCognitiveState
};
