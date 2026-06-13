const Redis = require('ioredis');
const config = require('../config');

if (!config.REDIS_URL) {
  console.warn('[Redis] Warning: REDIS_URL environment variable is missing. Client will attempt to connect to localhost:6379.');
}

const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  reconnectOnError: (err) => {
    console.error('[Redis] Connection error:', err);
    return true; 
  }
});

redis.on('connect', () => {
  console.log('[Redis] Connection established.');
});

redis.on('error', (err) => {
  console.error('[Redis] Client error:', err);
});

async function publishTelemetry(payload) {
  try {
    const message = JSON.stringify(payload);
    await redis.rpush(config.TELEMETRY_QUEUE, message);
    return true;
  } catch (error) {
    console.error('[Redis] Failed to queue telemetry:', error);
    throw error;
  }
}

module.exports = {
  redis,
  publishTelemetry
};
