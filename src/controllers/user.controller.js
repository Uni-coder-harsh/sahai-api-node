const pgPool = require('../database/pg');
const redis = require('../database/redis');
const crypto = require('crypto');

// Helper to hash passwords securely without external dependencies
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * Gets an existing institution ID by name, or creates a new one inside a transaction.
 */
async function getOrCreateInstitution(client, name, tier, region, state) {
  if (!name) return null;
  
  const selectQuery = 'SELECT id FROM institutions WHERE LOWER(name) = LOWER($1) LIMIT 1';
  const selectRes = await client.query(selectQuery, [name]);
  
  if (selectRes.rows.length > 0) {
    return selectRes.rows[0].id;
  }
  
  const insertQuery = `
    INSERT INTO institutions (name, domain_suffix, tier_classification, region, state)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id;
  `;
  const domainSuffix = name.toLowerCase().replace(/[^a-z0-9]/g, '') + '.edu';
  const insertRes = await client.query(insertQuery, [
    name.trim(),
    domainSuffix,
    tier || 'Tier-3',
    region || 'N/A',
    state || 'N/A'
  ]);
  
  return insertRes.rows[0].id;
}

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

    // Invalidate profile cache
    if (redis) {
      await redis.del(`user_profile:${user.id}`);
    }

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

/**
 * Registers a new student profile and maps/creates their institution.
 */
async function signupUser(req, res) {
  const {
    username,
    name,
    email,
    password,
    confirmPassword,
    phoneNumber,
    institutionName,
    institutionTier,
    institutionRegion,
    institutionState
  } = req.body;

  if (!username || !name || !email || !password) {
    return res.status(400).json({ error: 'Username, Name, Email, and Password are required.' });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get or create institution details
    let institutionId = null;
    if (institutionName) {
      institutionId = await getOrCreateInstitution(
        client,
        institutionName,
        institutionTier,
        institutionRegion,
        institutionState
      );
    }

    const pwdHash = hashPassword(password);
    const signupQuery = `
      INSERT INTO users (username, name, sso_email, password_hash, phone_number, institution_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      RETURNING id, username, name, sso_email;
    `;
    const signupRes = await client.query(signupQuery, [username, name, email, pwdHash, phoneNumber || null, institutionId]);
    const user = signupRes.rows[0];

    const { generateToken } = require('../middleware/auth');
    const token = generateToken(user.id);

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Registration successful.',
      user,
      token
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[UserController] Signup failed:', error);
    if (error.message.includes('unique constraint') || error.message.includes('duplicate key')) {
      return res.status(400).json({ error: 'Username or Email already exists.' });
    }
    res.status(500).json({ error: 'Registration failed.', details: error.message });
  } finally {
    client.release();
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
 * Initializes student-specific copies of concept mastery levels.
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

    // Invalidate Redis profile cache
    if (redis) {
      await redis.del(`user_profile:${user_id}`);
    }

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

/**
 * Retrieves the full user profile details, using Redis cache for zero-idle optimization.
 */
async function getUserProfile(req, res) {
  const { user_id } = req.params;

  try {
    // 1. Check Redis profile cache
    if (redis) {
      const cached = await redis.get(`user_profile:${user_id}`);
      if (cached) {
        console.log('[Redis] Cache HIT for user profile:', user_id);
        return res.json(JSON.parse(cached));
      }
    }

    // 2. Query Postgres on cache miss
    const profileRes = await pgPool.query(
      `SELECT u.id, u.username, u.name, u.sso_email, u.phone_number, u.academic_stream, 
              u.current_semester, u.graduation_year, u.current_cgpa, u.state_of_residence, 
              u.primary_language, u.device_signature, u.created_at, u.institution_id,
              i.name as institution_name, i.tier_classification as institution_tier,
              i.region as institution_region, i.state as institution_state
       FROM users u
       LEFT JOIN institutions i ON u.institution_id = i.id
       WHERE u.id = $1`,
      [user_id]
    );

    if (profileRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = profileRes.rows[0];

    // 3. Cache the user details (expires in 1 hour)
    if (redis) {
      console.log('[Redis] Cache MISS. Writing user profile to cache:', user_id);
      await redis.set(`user_profile:${user_id}`, JSON.stringify(user), 'EX', 3600);
    }

    res.json(user);
  } catch (error) {
    console.error('[UserController] Failed to retrieve user profile:', error);
    res.status(500).json({ error: 'Failed to retrieve user profile.', details: error.message });
  }
}

/**
 * Updates an existing user's profile info and invalidates cache.
 */
async function updateUserProfile(req, res) {
  const { user_id } = req.params;
  const {
    name,
    phone_number,
    academic_stream,
    current_semester,
    graduation_year,
    current_cgpa,
    state_of_residence,
    primary_language,
    institution_name,
    institution_tier,
    institution_region,
    institution_state,
    syllabus_referral,
    gate_paper_1,
    gate_paper_2,
    targeting_gate,
    avatar
  } = req.body;

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    // 1. Find or create institution details if provided
    let institutionId = null;
    if (institution_name) {
      institutionId = await getOrCreateInstitution(
        client,
        institution_name,
        institution_tier,
        institution_region,
        institution_state
      );
    }

    // 2. Preserve other device signature fields
    const selectSig = await client.query('SELECT device_signature FROM users WHERE id = $1', [user_id]);
    let currentSig = {};
    if (selectSig.rows.length > 0 && selectSig.rows[0].device_signature) {
      currentSig = selectSig.rows[0].device_signature;
      if (typeof currentSig === 'string') {
        try {
          currentSig = JSON.parse(currentSig);
        } catch (_) {}
      }
    }

    const updatedSig = {
      ...currentSig,
      syllabus_referral: syllabus_referral !== undefined ? syllabus_referral : currentSig.syllabus_referral,
      gate_paper_1: gate_paper_1 !== undefined ? gate_paper_1 : currentSig.gate_paper_1,
      gate_paper_2: gate_paper_2 !== undefined ? gate_paper_2 : currentSig.gate_paper_2,
      targeting_gate: targeting_gate !== undefined ? targeting_gate : currentSig.targeting_gate,
      avatar: avatar !== undefined ? avatar : currentSig.avatar
    };

    // 3. Update profile fields
    const updateQuery = `
      UPDATE users
      SET name = COALESCE($1, name),
          phone_number = COALESCE($2, phone_number),
          academic_stream = COALESCE($3, academic_stream),
          current_semester = COALESCE($4, current_semester),
          graduation_year = COALESCE($5, graduation_year),
          current_cgpa = COALESCE($6, current_cgpa),
          state_of_residence = COALESCE($7, state_of_residence),
          primary_language = COALESCE($8, primary_language),
          institution_id = COALESCE($9, institution_id),
          device_signature = $10,
          updated_at = NOW()
      WHERE id = $11
      RETURNING id;
    `;

    const updateRes = await client.query(updateQuery, [
      name || null,
      phone_number || null,
      academic_stream || null,
      current_semester ? parseInt(current_semester, 10) : null,
      graduation_year ? parseInt(graduation_year, 10) : null,
      current_cgpa ? parseFloat(current_cgpa) : null,
      state_of_residence || null,
      primary_language || null,
      institutionId || null,
      JSON.stringify(updatedSig),
      user_id
    ]);

    if (updateRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }

    await client.query('COMMIT');

    // 4. Invalidate Redis profile cache
    if (redis) {
      console.log('[Redis] Invalidating profile cache for user:', user_id);
      await redis.del(`user_profile:${user_id}`);
    }

    res.json({ status: 'success', message: 'Profile updated successfully.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[UserController] Update profile failed:', error);
    res.status(500).json({ error: 'Failed to update profile.', details: error.message });
  } finally {
    client.release();
  }
}

/**
 * Returns a list of all institutions registered in the system.
 */
async function getInstitutionsList(req, res) {
  try {
    const query = 'SELECT id, name, tier_classification as tier, region, state FROM institutions ORDER BY name ASC';
    const result = await pgPool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('[UserController] Failed to fetch institutions list:', error);
    res.status(500).json({ error: 'Failed to fetch institutions list.', details: error.message });
  }
}

module.exports = {
  onboardUser,
  getCognitiveState,
  signupUser,
  loginUser,
  personalizeEngine,
  getUserProfile,
  updateUserProfile,
  getInstitutionsList
};
