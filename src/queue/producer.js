const config = require('../config');

/**
 * Sends telemetry events directly to the Python mathematical engine via HTTP.
 * Captures and returns the mathematical / behavioral metrics computed by the Python engine.
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
      return { success: false, error: errorText };
    } else {
      const result = await response.json();
      console.log('[Telemetry] Python engine processed telemetry successfully.', result);
      return result;
    }
  } catch (error) {
    console.error('[Telemetry] Failed to notify Python engine via HTTP request:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  publishTelemetry
};
