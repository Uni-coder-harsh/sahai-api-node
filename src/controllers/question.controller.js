const pgPool = require('../database/pg');
const { publishTelemetry } = require('../queue/producer');
const { getMongoDb } = require('../database/mongo');

/**
 * Fetches the list of initial diagnostic MCQ questions (with options).
 */
async function getInitialQuestions(req, res) {
  try {
    const questionsQuery = `
      SELECT id, question_text, difficulty_level, expected_time
      FROM questions
      WHERE is_initial_test = TRUE
      ORDER BY difficulty_level ASC;
    `;
    const questionsRes = await pgPool.query(questionsQuery);
    const questions = questionsRes.rows;

    const questionIds = questions.map(q => q.id);
    if (questionIds.length === 0) {
      return res.json([]);
    }

    const optionsQuery = `
      SELECT id, question_id, option_letter, option_text
      FROM options
      WHERE question_id = ANY($1)
      ORDER BY question_id, option_letter;
    `;
    const optionsRes = await pgPool.query(optionsQuery, [questionIds]);
    const options = optionsRes.rows;

    // Map options to their respective questions
    const questionsWithOptions = questions.map(q => {
      return {
        ...q,
        options: options.filter(o => o.question_id === q.id)
      };
    });

    res.json(questionsWithOptions);
  } catch (error) {
    console.error('[QuestionController] Failed to fetch diagnostic questions:', error);
    res.status(500).json({ error: 'Failed to fetch diagnostic questions.', details: error.message });
  }
}

/**
 * Submits an answer to a question. Evaluates correctness, fetches linked concepts/misconceptions,
 * and enqueues telemetry events to the Redis queue for the math worker to process.
 */
async function submitAnswer(req, res) {
  const { user_id, question_id, option_id, time_spent_seconds } = req.body;

  if (!user_id || !question_id || !option_id) {
    return res.status(400).json({ error: 'user_id, question_id, and option_id are required.' });
  }

  try {
    // 1. Fetch question and check correctness
    const questionQuery = `
      SELECT id, correct_option_id, difficulty_level
      FROM questions
      WHERE id = $1;
    `;
    const questionRes = await pgPool.query(questionQuery, [question_id]);
    if (questionRes.rows.length === 0) {
      return res.status(404).json({ error: 'Question not found.' });
    }
    const question = questionRes.rows[0];
    const isCorrect = (question.correct_option_id === option_id);

    // 2. Fetch concepts linked to this question
    const conceptLinksQuery = `
      SELECT node_id, weight
      FROM question_concept_links
      WHERE question_id = $1;
    `;
    const conceptLinksRes = await pgPool.query(conceptLinksQuery, [question_id]);
    const conceptLinks = conceptLinksRes.rows;

    // 3. Fetch misconceptions linked to the selected option if wrong
    let misconceptions = [];
    if (!isCorrect) {
      const misconceptionsQuery = `
        SELECT node_id, weight
        FROM option_concept_misconceptions
        WHERE option_id = $1;
      `;
      const misconceptionsRes = await pgPool.query(misconceptionsQuery, [option_id]);
      misconceptions = misconceptionsRes.rows;
    }

    // Save student response in PostgreSQL logs for profiling and personalization
    const insertResponseQuery = `
      INSERT INTO user_question_responses (user_id, question_id, option_id, is_correct, time_spent_seconds)
      VALUES ($1, $2, $3, $4, $5);
    `;
    await pgPool.query(insertResponseQuery, [user_id, question_id, option_id, isCorrect, time_spent_seconds || 30]);

    // 4. Send telemetry events for each primary concept linked to the question
    const telemetryEvents = [];
    for (const link of conceptLinks) {
      const payload = {
        user_id,
        node_id: link.node_id,
        event_type: 'MCQ_SUBMISSION',
        success: isCorrect,
        attempts: 1,
        code_snippet: `Chosen Option ID: ${option_id}`,
        behavioral_flags: isCorrect ? [] : ['MCQ_INCORRECT'],
        time_spent_seconds: time_spent_seconds || 30,
        // Send along primary connection weight
        influence_weight: parseFloat(link.weight),
        // Send along misconceptions for potential updates
        misconceptions: misconceptions.map(m => ({
          node_id: m.node_id,
          weight: parseFloat(m.weight)
        })),
        timestamp: new Date()
      };

      // Ingest in Mongo raw logs first
      const mongoDb = getMongoDb();
      await mongoDb.collection('telemetry_raw').insertOne(payload);

      // Publish to Redis telemetry queue
      await publishTelemetry(payload);
      telemetryEvents.push(payload);
    }

    // If no concepts are linked, send a default telemetry event
    if (conceptLinks.length === 0) {
      const payload = {
        user_id,
        node_id: 'CS_PY_SYNTAX',
        event_type: 'MCQ_SUBMISSION',
        success: isCorrect,
        attempts: 1,
        code_snippet: `Chosen Option ID: ${option_id}`,
        behavioral_flags: isCorrect ? [] : ['MCQ_INCORRECT'],
        time_spent_seconds: time_spent_seconds || 30,
        timestamp: new Date()
      };
      const mongoDb = getMongoDb();
      await mongoDb.collection('telemetry_raw').insertOne(payload);
      await publishTelemetry(payload);
    }

    res.json({
      success: isCorrect,
      correct_option_id: question.correct_option_id,
      message: isCorrect ? 'Correct answer!' : 'Incorrect answer.',
      concepts_evaluated: conceptLinks.map(c => c.node_id),
      misconceptions_detected: misconceptions.map(m => m.node_id)
    });
  } catch (error) {
    console.error('[QuestionController] Failed to submit answer:', error);
    res.status(500).json({ error: 'Failed to submit answer.', details: error.message });
  }
}

/**
 * Fetches practice questions dynamically based on student's weakest subtopics.
 */
async function getPracticeQuestions(req, res) {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id query parameter is required.' });
  }

  try {
    // 1. Fetch user's cognitive states to find weakest subtopics (mastery < 0.5)
    const cognitiveStateQuery = `
      SELECT node_id, expected_mastery
      FROM user_cognitive_states
      WHERE user_id = $1 AND node_id LIKE 'CS_PY_%'
      ORDER BY expected_mastery ASC;
    `;
    const cognitiveStateRes = await pgPool.query(cognitiveStateQuery, [user_id]);
    const cognitiveStates = cognitiveStateRes.rows;

    let targetNodes = [];
    if (cognitiveStates.length > 0) {
      // Find nodes with mastery < 0.6, or just take the top 3 weakest
      targetNodes = cognitiveStates.slice(0, 3).map(cs => cs.node_id);
    }

    // Default to CS_PY_SYNTAX if no states are initialized yet
    if (targetNodes.length === 0) {
      targetNodes = ['CS_PY_SYNTAX'];
    }

    // 2. Fetch practice questions linked to these target subtopics
    const questionsQuery = `
      SELECT DISTINCT q.id, q.question_text, q.difficulty_level, q.expected_time
      FROM questions q
      JOIN question_concept_links qcl ON q.id = qcl.question_id
      WHERE q.is_initial_test = FALSE AND qcl.node_id = ANY($1)
      LIMIT 5;
    `;
    const questionsRes = await pgPool.query(questionsQuery, [targetNodes]);
    let questions = questionsRes.rows;

    // Fallback if no questions are linked to the weakest nodes: just load general practice questions
    if (questions.length === 0) {
      const fallbackQuery = `
        SELECT id, question_text, difficulty_level, expected_time
        FROM questions
        WHERE is_initial_test = FALSE
        LIMIT 5;
      `;
      const fallbackRes = await pgPool.query(fallbackQuery);
      questions = fallbackRes.rows;
    }

    const questionIds = questions.map(q => q.id);
    if (questionIds.length === 0) {
      return res.json([]);
    }

    // 3. Fetch options for these questions
    const optionsQuery = `
      SELECT id, question_id, option_letter, option_text
      FROM options
      WHERE question_id = ANY($1)
      ORDER BY question_id, option_letter;
    `;
    const optionsRes = await pgPool.query(optionsQuery, [questionIds]);
    const options = optionsRes.rows;

    const questionsWithOptions = questions.map(q => {
      return {
        ...q,
        options: options.filter(o => o.question_id === q.id)
      };
    });

    res.json(questionsWithOptions);
  } catch (error) {
    console.error('[QuestionController] Failed to fetch practice questions:', error);
    res.status(500).json({ error: 'Failed to fetch practice questions.', details: error.message });
  }
}

module.exports = {
  getInitialQuestions,
  submitAnswer,
  getPracticeQuestions
};
