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
  const { 
    user_id, 
    question_id, 
    option_id, 
    time_spent_seconds,
    run_count,
    backspace_count,
    paste_char_count,
    syntax_error_count,
    question_word_count,
    time_to_first_action_sec,
    reading_velocity,
    option_switch_count,
    minimum_click_interval_ms,
    network_drop_duration_sec
  } = req.body;

  if (!user_id || !question_id || !option_id) {
    return res.status(400).json({ error: 'user_id, question_id, and option_id are required.' });
  }

  const currentLanguage = req.headers['x-app-language'] || 'en';

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
    const telemetryEventsRes = [];
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
        run_count: parseInt(run_count || 0),
        backspace_count: parseInt(backspace_count || 0),
        paste_char_count: parseInt(paste_char_count || 0),
        syntax_error_count: parseInt(syntax_error_count || 0),
        language: currentLanguage,
        // Send along primary connection weight
        influence_weight: parseFloat(link.weight),
        // Send along misconceptions for potential updates
        misconceptions: misconceptions.map(m => ({
          node_id: m.node_id,
          weight: parseFloat(m.weight)
        })),
        timestamp: new Date(),
        // MCQ features
        question_word_count: parseInt(question_word_count || 40),
        time_to_first_action_sec: parseFloat(time_to_first_action_sec || 10.0),
        reading_velocity: parseFloat(reading_velocity || 3.0),
        option_switch_count: parseInt(option_switch_count || 0),
        minimum_click_interval_ms: parseFloat(minimum_click_interval_ms || 1000.0),
        network_drop_duration_sec: parseFloat(network_drop_duration_sec || 0.0),
        total_time_spent_sec: parseFloat(time_spent_seconds || 30.0),
        metrics: {
          question_word_count: parseInt(question_word_count || 40),
          time_to_first_action_sec: parseFloat(time_to_first_action_sec || 10.0),
          reading_velocity: parseFloat(reading_velocity || 3.0),
          option_switch_count: parseInt(option_switch_count || 0),
          minimum_click_interval_ms: parseFloat(minimum_click_interval_ms || 1000.0),
          network_drop_duration_sec: parseFloat(network_drop_duration_sec || 0.0),
          total_time_spent_sec: parseFloat(time_spent_seconds || 30.0)
        }
      };

      // Ingest in Mongo raw logs first
      const mongoDb = getMongoDb();
      await mongoDb.collection('telemetry_raw').insertOne(payload);

      // Publish telemetry directly to Python math server via HTTP
      const mathUpdateResult = await publishTelemetry(payload);
      if (!mathUpdateResult || !mathUpdateResult.success) {
        throw new Error(mathUpdateResult?.error || 'Failed to update Bayesian cognitive parameters. Math Engine is offline.');
      }
      telemetryEventsRes.push({
        node_id: link.node_id,
        ...mathUpdateResult
      });
    }

    // If no concepts are linked, send a default telemetry event
    if (conceptLinks.length === 0) {
      const payload = {
        user_id,
        node_id: 'PY_SYNTAX_01',
        event_type: 'MCQ_SUBMISSION',
        success: isCorrect,
        attempts: 1,
        code_snippet: `Chosen Option ID: ${option_id}`,
        behavioral_flags: isCorrect ? [] : ['MCQ_INCORRECT'],
        time_spent_seconds: time_spent_seconds || 30,
        run_count: parseInt(run_count || 0),
        backspace_count: parseInt(backspace_count || 0),
        paste_char_count: parseInt(paste_char_count || 0),
        syntax_error_count: parseInt(syntax_error_count || 0),
        language: currentLanguage,
        timestamp: new Date(),
        // MCQ features
        question_word_count: parseInt(question_word_count || 40),
        time_to_first_action_sec: parseFloat(time_to_first_action_sec || 10.0),
        reading_velocity: parseFloat(reading_velocity || 3.0),
        option_switch_count: parseInt(option_switch_count || 0),
        minimum_click_interval_ms: parseFloat(minimum_click_interval_ms || 1000.0),
        network_drop_duration_sec: parseFloat(network_drop_duration_sec || 0.0),
        total_time_spent_sec: parseFloat(time_spent_seconds || 30.0),
        metrics: {
          question_word_count: parseInt(question_word_count || 40),
          time_to_first_action_sec: parseFloat(time_to_first_action_sec || 10.0),
          reading_velocity: parseFloat(reading_velocity || 3.0),
          option_switch_count: parseInt(option_switch_count || 0),
          minimum_click_interval_ms: parseFloat(minimum_click_interval_ms || 1000.0),
          network_drop_duration_sec: parseFloat(network_drop_duration_sec || 0.0),
          total_time_spent_sec: parseFloat(time_spent_seconds || 30.0)
        }
      };
      const mongoDb = getMongoDb();
      await mongoDb.collection('telemetry_raw').insertOne(payload);
      const mathUpdateResult = await publishTelemetry(payload);
      if (!mathUpdateResult || !mathUpdateResult.success) {
        throw new Error(mathUpdateResult?.error || 'Failed to update Bayesian cognitive parameters. Math Engine is offline.');
      }
      telemetryEventsRes.push({
        node_id: 'PY_SYNTAX_01',
        ...mathUpdateResult
      });
    }

    let tutorFeedback = null;
    for (const update of telemetryEventsRes) {
      if (update.tutor_feedback) {
        tutorFeedback = update.tutor_feedback;
        break;
      }
    }

    res.json({
      success: isCorrect,
      correct_option_id: question.correct_option_id,
      message: isCorrect ? 'Correct answer!' : 'Incorrect answer.',
      concepts_evaluated: conceptLinks.map(c => c.node_id),
      misconceptions_detected: misconceptions.map(m => m.node_id),
      telemetry_updates: telemetryEventsRes,
      tutor_feedback: tutorFeedback
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
      WHERE user_id = $1 AND node_id LIKE 'PY_%'
      ORDER BY expected_mastery ASC;
    `;
    const cognitiveStateRes = await pgPool.query(cognitiveStateQuery, [user_id]);
    const cognitiveStates = cognitiveStateRes.rows;

    let targetNodes = [];
    if (cognitiveStates.length > 0) {
      // Find nodes with mastery < 0.6, or just take the top 3 weakest
      targetNodes = cognitiveStates.slice(0, 3).map(cs => cs.node_id);
    }

    // Default to PY_SYNTAX_01 if no states are initialized yet
    if (targetNodes.length === 0) {
      targetNodes = ['PY_SYNTAX_01'];
    }

    // 2. Fetch practice questions linked to these target subtopics, excluding already solved questions
    const questionsQuery = `
      SELECT DISTINCT q.id, q.question_text, q.difficulty_level, q.expected_time
      FROM questions q
      JOIN question_concept_links qcl ON q.id = qcl.question_id
      WHERE q.is_initial_test = FALSE 
        AND qcl.node_id = ANY($1)
        AND q.id NOT IN (
          SELECT question_id FROM user_question_responses WHERE user_id = $2 AND is_correct = TRUE
        )
      LIMIT 5;
    `;
    const questionsRes = await pgPool.query(questionsQuery, [targetNodes, user_id]);
    let questions = questionsRes.rows;

    // Fallback if no questions are linked to the weakest nodes: load general uncompleted practice questions
    if (questions.length === 0) {
      const fallbackQuery = `
        SELECT id, question_text, difficulty_level, expected_time
        FROM questions
        WHERE is_initial_test = FALSE
          AND id NOT IN (
            SELECT question_id FROM user_question_responses WHERE user_id = $1 AND is_correct = TRUE
          )
        LIMIT 5;
      `;
      const fallbackRes = await pgPool.query(fallbackQuery, [user_id]);
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

/**
 * Fetches user question response history.
 */
async function getAttemptHistory(req, res) {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id query parameter is required.' });
  }

  try {
    const historyQuery = `
      SELECT uqr.id, uqr.is_correct, uqr.time_spent_seconds, uqr.created_at,
             q.question_text, q.difficulty_level,
             opt.option_letter as chosen_option_letter, opt.option_text as chosen_option_text,
             corr_opt.option_letter as correct_option_letter, corr_opt.option_text as correct_option_text,
             (
               SELECT string_agg(ocm.node_id, ', ')
               FROM option_concept_misconceptions ocm
               WHERE ocm.option_id = uqr.option_id
             ) as misconceptions
      FROM user_question_responses uqr
      JOIN questions q ON uqr.question_id = q.id
      JOIN options opt ON uqr.option_id = opt.id
      LEFT JOIN options corr_opt ON q.correct_option_id = corr_opt.id
      WHERE uqr.user_id = $1
      ORDER BY uqr.created_at DESC;
    `;
    const historyRes = await pgPool.query(historyQuery, [user_id]);
    res.json(historyRes.rows);
  } catch (error) {
    console.error('[QuestionController] Failed to fetch attempt history:', error);
    res.status(500).json({ error: 'Failed to fetch attempt history.', details: error.message });
  }
}

/**
 * Fetches all questions in the bank, enriched with student-specific attempt statuses.
 */
async function getAllQuestions(req, res) {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id query parameter is required.' });
  }

  try {
    const query = `
      SELECT q.id, q.question_text, q.difficulty_level, q.expected_time, q.is_initial_test,
             (
               SELECT CASE 
                 WHEN COUNT(uqr.id) = 0 THEN 'UNATTEMPTED'
                 WHEN bool_or(uqr.is_correct) THEN 'COMPLETED'
                 ELSE 'ATTEMPTED'
               END
               FROM user_question_responses uqr
               WHERE uqr.question_id = q.id AND uqr.user_id = $1
             ) as status,
             (
               SELECT string_agg(qcl.node_id, ', ')
               FROM question_concept_links qcl
               WHERE qcl.question_id = q.id
             ) as concept_nodes
      FROM questions q
      ORDER BY q.is_initial_test DESC, q.difficulty_level ASC;
    `;
    const result = await pgPool.query(query, [user_id]);
    res.json(result.rows);
  } catch (error) {
    console.error('[QuestionController] Failed to fetch all questions:', error);
    res.status(500).json({ error: 'Failed to fetch all questions.', details: error.message });
  }
}

/**
 * Fetches options and metadata for a single question.
 */
async function getQuestionDetails(req, res) {
  const { id } = req.params;

  try {
    const questionRes = await pgPool.query(
      'SELECT id, question_text, difficulty_level, expected_time, is_initial_test FROM questions WHERE id = $1',
      [id]
    );

    if (questionRes.rows.length === 0) {
      return res.status(404).json({ error: 'Question not found.' });
    }

    const question = questionRes.rows[0];

    const optionsRes = await pgPool.query(
      'SELECT id, question_id, option_letter, option_text FROM options WHERE question_id = $1 ORDER BY option_letter ASC',
      [id]
    );
    question.options = optionsRes.rows;

    res.json(question);
  } catch (error) {
    console.error('[QuestionController] Failed to fetch question details:', error);
    res.status(500).json({ error: 'Failed to fetch question details.', details: error.message });
  }
}

module.exports = {
  getInitialQuestions,
  submitAnswer,
  getPracticeQuestions,
  getAttemptHistory,
  getAllQuestions,
  getQuestionDetails
};
