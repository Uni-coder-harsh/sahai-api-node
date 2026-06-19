const { rateLimit } = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default || require('rate-limit-redis');
const redisClient = require('../database/redis');

// Redis-backed rate limiter: 1 request every 5 seconds per user
const telemetryRateLimiter = rateLimit({
  windowMs: 5000, // 5 seconds
  max: 1, // Limit each user_id to 1 request per windowMs
  standardHeaders: true, // Return standard rate limit headers
  legacyHeaders: false, // Disable older X-RateLimit-* headers
  store: new RedisStore({
    sendCommand: (...args) => {
      if (!redisClient) {
        // Fallback for environment/testing when Redis connection is not established
        return Promise.resolve();
      }
      return redisClient.call(...args);
    },
  }),
  keyGenerator: (req) => {
    // Identify client by authenticated user ID from JWT Bearer token
    return req.userId || req.ip;
  },
  handler: (req, res) => {
    return res.status(429).json({
      error: 'Too Many Requests',
      message: 'You can only submit telemetry once every 5 seconds.'
    });
  }
});

module.exports = {
  telemetryRateLimiter
};
