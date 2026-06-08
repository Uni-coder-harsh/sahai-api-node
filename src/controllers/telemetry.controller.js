const { getMongoDb } = require('../database/mongo');
const { publishTelemetry } = require('../queue/producer');
const crypto = require('crypto');

/**
 * Ingests telemetry, commits it to the MongoDB event store, and buffers it to Redis.
 */
async function ingestTelemetry(req, res) {
  const {
    user_id,
    node_id,
    event_type,
    success,
    attempts,
    code_snippet,
    behavioral_flags,
    time_spent_seconds
  } = req.body;

  if (!user_id || !node_id || !event_type) {
    return res.status(400).json({ error: 'user_id, node_id, and event_type are required.' });
  }

  try {
    const rawEvent = {
      event_id: crypto.randomUUID ? crypto.randomUUID() : require('crypto').randomUUID(),
      user_id,
      node_id,
      event_type,
      success: success !== undefined ? success : false,
      attempts: attempts || 1,
      code_snippet: code_snippet || null,
      behavioral_flags: behavioral_flags || [],
      time_spent_seconds: time_spent_seconds || 0,
      timestamp: new Date()
    };

    // Store in MongoDB Event Store (Event Sourcing)
    const mongoDb = getMongoDb();
    await mongoDb.collection('telemetry_raw').insertOne(rawEvent);

    // Buffer event in Redis telemetry queue
    await publishTelemetry(rawEvent);

    res.status(202).json({
      message: 'Telemetry event ingested successfully.',
      event_id: rawEvent.event_id
    });
  } catch (error) {
    console.error('[TelemetryController] Ingestion failed:', error);
    res.status(500).json({ error: 'Failed to ingest telemetry.', details: error.message });
  }
}

module.exports = {
  ingestTelemetry
};
