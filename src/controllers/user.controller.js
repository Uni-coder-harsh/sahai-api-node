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
          VALUES ($1, $2, 2.0, 2.0, 0.5000)
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
  getCognitiveState,
  signupUser,
  loginUser,
  personalizeEngine,
  getUserProfile
};

/**
 * Retrieves the full user profile details.
 */
async function getUserProfile(req, res) {
  const { user_id } = req.params;

  try {
    const profileRes = await pgPool.query(
      `SELECT id, username, name, sso_email, phone_number, academic_stream, current_semester, device_signature, created_at
       FROM users
       WHERE id = $1`,
      [user_id]
    );

    if (profileRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = profileRes.rows[0];
    res.json(user);
  } catch (error) {
    console.error('[UserController] Failed to retrieve user profile:', error);
    res.status(500).json({ error: 'Failed to retrieve user profile.', details: error.message });
  }
}

const crypto = require('crypto');

// Helper to hash passwords securely without external dependencies
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * Registers a new student profile in the database.
 */
async function signupUser(req, res) {
  const { username, name, email, password, confirmPassword, phoneNumber } = req.body;

  if (!username || !name || !email || !password) {
    return res.status(400).json({ error: 'Username, Name, Email, and Password are required.' });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  try {
    const pwdHash = hashPassword(password);
    const signupQuery = `
      INSERT INTO users (username, name, sso_email, password_hash, phone_number, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      RETURNING id, username, name, sso_email;
    `;
    const signupRes = await pgPool.query(signupQuery, [username, name, email, pwdHash, phoneNumber || null]);
    const user = signupRes.rows[0];

    const { generateToken } = require('../middleware/auth');
    const token = generateToken(user.id);

    res.status(201).json({
      message: 'Registration successful.',
      user,
      token
    });
  } catch (error) {
    console.error('[UserController] Signup failed:', error);
    if (error.message.includes('unique constraint') || error.message.includes('duplicate key')) {
      return res.status(400).json({ error: 'Username or Email already exists.' });
    }
    res.status(500).json({ error: 'Registration failed.', details: error.message });
  }
}

/**
 * Authenticates a student via username/email and password.
 */
async function loginUser(req, res) {
  const { usernameOrEmail, password } = req.body;

  if (!usernameOrEmail || !password) {
    return res.status(400).json({ error: 'Username/Email and Password are required.' });
  }

  try {
    const pwdHash = hashPassword(password);
    const loginQuery = `
      SELECT id, username, name, sso_email, password_hash, academic_stream, current_semester
      FROM users
      WHERE username = $1 OR sso_email = $1;
    `;
    const loginRes = await pgPool.query(loginQuery, [usernameOrEmail]);

    if (loginRes.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username/email or password.' });
    }

    const user = loginRes.rows[0];
    if (user.password_hash !== pwdHash) {
      return res.status(401).json({ error: 'Invalid username/email or password.' });
    }

    const { generateToken } = require('../middleware/auth');
    const token = generateToken(user.id);

    delete user.password_hash;
    res.json({
      message: 'Login successful.',
      user,
      token
    });
  } catch (error) {
    console.error('[UserController] Login failed:', error);
    res.status(500).json({ error: 'Login failed.', details: error.message });
  }
}

/**
 * Personalizes the cognitive engine for a student.
 * Initializes student-specific copies of concept mastery levels and subtopic correlations.
 */
async function personalizeEngine(req, res) {
  const { user_id } = req.params;
  const {
    domain,
    course,
    semester,
    syllabusTextOrLink,
    gateExam,
    gatePaper1,
    gatePaper2
  } = req.body;

  if (!domain) {
    return res.status(400).json({ error: 'Domain is required.' });
  }

  if (domain.toUpperCase() !== 'CS') {
    return res.json({
      status: 'progress',
      message: 'we are still in progress with your domain we currently support cs, we have considered your request thank you.'
    });
  }

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    const updateQuery = `
      UPDATE users
      SET academic_stream = $1,
          current_semester = $2,
          device_signature = COALESCE(device_signature, '{}'::jsonb) || $3::jsonb,
          updated_at = NOW()
      WHERE id = $4
      RETURNING id, username, name, academic_stream, current_semester;
    `;
    
    const stream = `${course || 'B.Tech'} CSE`;
    const extraDetails = {
      syllabus_referral: syllabusTextOrLink || '',
      targeting_gate: gateExam || false,
      gate_paper_1: gatePaper1 || '',
      gate_paper_2: gatePaper2 || ''
    };

    const updateRes = await client.query(updateQuery, [
      stream,
      semester ? parseInt(semester, 10) : 1,
      JSON.stringify(extraDetails),
      user_id
    ]);

    if (updateRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = updateRes.rows[0];

    // Copy CS concept nodes to user_cognitive_states
    const conceptsRes = await client.query(
      "SELECT node_id, difficulty_baseline FROM concept_nodes WHERE domain = 'CS'"
    );

    if (conceptsRes.rows.length > 0) {
      const stateQueries = conceptsRes.rows.map(concept => {
        return client.query(`
          INSERT INTO user_cognitive_states (user_id, node_id, alpha, beta, expected_mastery)
          VALUES ($1, $2, 2.0, 2.0, $3)
          ON CONFLICT (user_id, node_id) DO NOTHING;
        `, [user_id, concept.node_id, concept.difficulty_baseline]);
      });
      await Promise.all(stateQueries);
    }
    await client.query('COMMIT');
    res.json({
      status: 'success',
      message: 'Engine personalized and student-specific cognitive graph initialized.',
      user
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[UserController] Personalization failed:', error);
    res.status(500).json({ error: 'Failed to personalize engine.', details: error.message });
  } finally {
    client.release();
  }
}
