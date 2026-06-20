const crypto = require('crypto');
const { z } = require('zod');
const redisClient = require('../database/redis');
const config = require('../config');

// Define Zod validation schema with robust pre-processing to ensure compatibility
const telemetrySchema = z.object({
  interaction_type: z.string().optional().default('Code'),
  metrics: z.object().passthrough().optional().default({}),
  user_id: z.string().optional()
}).passthrough();

/**
 * POST /api/telemetry Express Controller
 * Validates incoming telemetry payload, formats the event envelope,
 * and pushes to Upstash Redis queue. Returns 202 Accepted immediately.
 */
async function ingestTelemetry(req, res) {
  try {
    // For backward compatibility: if metrics is missing but root has properties, build metrics
    if (!req.body.metrics) {
      req.body.metrics = {
        time_spent_seconds: req.body.time_spent_seconds || req.body.time_spent_sec || 30,
        run_count: req.body.run_count || req.body.compile_count || 0,
        backspace_count: req.body.backspace_count || 0,
        paste_char_count: req.body.paste_char_count || 0,
        syntax_error_count: req.body.syntax_error_count || 0,
        is_correct: req.body.success !== undefined ? req.body.success : true
      };
    }
    if (!req.body.interaction_type && req.body.event_type) {
      req.body.interaction_type = req.body.event_type;
    }

    // 1. Validate incoming request body
    const parseResult = telemetrySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed.',
        details: parseResult.error.errors
      });
    }

    const { interaction_type, metrics } = parseResult.data;
    
    // Extract user_id exclusively from the verified JWT Bearer token (populated in authRequired middleware)
    const finalUserId = req.userId;
    if (!finalUserId) {
      return res.status(401).json({ error: 'Unauthorized. Authenticated user ID is required.' });
    }

    const currentLanguage = req.headers['x-app-language'] || 'en';

    // 2. Build the flexible schemaless telemetry event with mandated top-level keys
    const rawEvent = {
      event_id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
      user_id: finalUserId,
      interaction_type,
      timestamp: new Date().toISOString(),
      metrics,
      language: currentLanguage,
      // Add optional standard keys if they exist in req.body
      node_id: req.body.node_id || null,
      success: req.body.success !== undefined ? req.body.success : true,
      attempts: req.body.attempts || 1,
      code_snippet: req.body.code_snippet || null,
      behavioral_flags: req.body.behavioral_flags || [],
      // Handwriting OCR / Grader keys
      image_base64: req.body.image_base64 || null,
      question_id: req.body.question_id || null,
      time_spent_sec: req.body.time_spent_sec || req.body.time_spent_seconds || null,
      run_count: req.body.run_count || null,
      backspace_count: req.body.backspace_count || null,
      paste_char_count: req.body.paste_char_count || null,
      syntax_error_count: req.body.syntax_error_count || null,
      label: req.body.label || null
    };

    // 3. For OCR_HANDWRITING events, process synchronously by calling the Python math engine `/process-telemetry` endpoint
    if (interaction_type === 'OCR_HANDWRITING') {
      const pythonEngineUrl = config.ENGINE_PYTHON_URL || 'http://localhost:5000';
      try {
        console.log(`[TelemetryController] Synchronously processing OCR_HANDWRITING event: ${rawEvent.event_id} (Language: ${currentLanguage})`);
        const pythonResponse = await fetch(`${pythonEngineUrl}/process-telemetry`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-App-Language': currentLanguage
          },
          body: JSON.stringify(rawEvent)
        });
        
        if (!pythonResponse.ok) {
          const errText = await pythonResponse.text();
          throw new Error(`Python engine returned status ${pythonResponse.status}: ${errText}`);
        }
        
        const pythonResult = await pythonResponse.json();
        
        return res.status(200).json({
          message: 'Handwriting telemetry processed synchronously.',
          event_id: rawEvent.event_id,
          ...pythonResult
        });
      } catch (err) {
        console.error('[TelemetryController] Synchronous Python handler execution failed:', err);
        return res.status(500).json({
          error: 'Failed to process handwriting telemetry synchronously.',
          details: err.message
        });
      }
    }

    // 4. Push to Upstash Redis List / Stream for other telemetry events
    if (redisClient) {
      await redisClient.rpush(config.TELEMETRY_QUEUE, JSON.stringify(rawEvent));
      console.log(`[TelemetryController] Buffered event ${rawEvent.event_id} to queue: ${config.TELEMETRY_QUEUE}`);
      
      // Trigger Python math engine asynchronously (fire-and-forget) to process the queue on-demand
      const pythonEngineUrl = config.ENGINE_PYTHON_URL || 'http://localhost:5000';
      fetch(`${pythonEngineUrl}/trigger-process-queue`, { method: 'POST' }).catch(err => {
        console.error('[TelemetryController] Failed to trigger Python queue processing:', err.message);
      });
    } else {
      console.warn('[TelemetryController] Warning: Redis client is not initialized. Dropping event on queue.');
      return res.status(500).json({ error: 'Redis queue connection not available.' });
    }

    // 5. Return HTTP 202 Accepted immediately for non-blocking events
    return res.status(202).json({
      message: 'Telemetry event accepted for processing.',
      event_id: rawEvent.event_id
    });

  } catch (error) {
    console.error('[TelemetryController] Ingestion error:', error);
    return res.status(500).json({
      error: 'Failed to process telemetry ingestion.',
      details: error.message
    });
  }
}

module.exports = {
  ingestTelemetry
};
