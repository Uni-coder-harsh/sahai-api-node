const Redis = require('ioredis');
const config = require('../config');

let redis = null;

if (config.REDIS_URL) {
  let redisUrl = config.REDIS_URL;
  const redisOptions = {
    maxRetriesPerRequest: null,
    reconnectOnError: (err) => {
      console.error('[Redis] Connection error:', err);
      return true; 
    }
  };

  if (redisUrl.startsWith('redis://') && !redisUrl.includes('localhost') && !redisUrl.includes('127.0.0.1')) {
    redisUrl = redisUrl.replace('redis://', 'rediss://');
  }

  if (redisUrl.startsWith('rediss://')) {
    redisOptions.tls = {
      rejectUnauthorized: false
    };
  }

  redis = new Redis(redisUrl, redisOptions);

  redis.on('connect', () => {
    console.log('[Redis] Connection established.');
  });

  redis.on('error', (err) => {
    console.error('[Redis] Client error:', err);
  });
}

module.exports = redis;
