const Redis = require('ioredis');
const config = require('../config');

if (!config.REDIS_URL) {
  console.warn('[Redis] Warning: REDIS_URL environment variable is missing. Client will attempt to connect to localhost:6379.');
}

let redisUrl = config.REDIS_URL;
const redisOptions = {
  maxRetriesPerRequest: null,
  reconnectOnError: (err) => {
    console.error('[Redis] Connection error:', err);
    return true; 
  }
};

if (redisUrl && redisUrl.startsWith('redis://') && !redisUrl.includes('localhost') && !redisUrl.includes('127.0.0.1')) {
  redisUrl = redisUrl.replace('redis://', 'rediss://');
}

if (redisUrl && redisUrl.startsWith('rediss://')) {
  redisOptions.tls = {
    rejectUnauthorized: false
  };
}

const redis = new Redis(redisUrl, redisOptions);

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
