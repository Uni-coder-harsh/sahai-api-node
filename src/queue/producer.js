const config = require('../config');

/**
 * Sends telemetry events directly to the Python mathematical engine via HTTP.
 * This replaces the Redis queueing mechanism, saving connection overhead and Upstash costs.
 */
async function publishTelemetry(payload) {
  try {
    const pythonEngineUrl = config.ENGINE_PYTHON_URL || 'http://localhost:5000';
    console.log(`[Telemetry] Relaying telemetry event to Python engine via HTTP at: ${pythonEngineUrl}/process-telemetry`);
    
    const response = await fetch(`${pythonEngineUrl}/process-telemetry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Telemetry] Python engine returned error status ${response.status}: ${errorText}`);
    } else {
      console.log('[Telemetry] Python engine processed telemetry successfully.');
    }
    return true;
  } catch (error) {
    console.error('[Telemetry] Failed to notify Python engine via HTTP request:', error);
    return false;
  }
}

module.exports = {
  publishTelemetry
};
