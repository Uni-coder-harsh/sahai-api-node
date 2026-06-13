const express = require('express');
const cors = require('cors');
const pgPool = require('./database/pg');
const { getMongoDb } = require('./database/mongo');

const userRoutes = require('./routes/user.routes');
const telemetryRoutes = require('./routes/telemetry.routes');
const curriculumRoutes = require('./routes/curriculum.routes');
const questionRoutes = require('./routes/question.routes');

const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());
const logger = require('./utils/logger');

// Serve static assets from Flutter web build
app.use(express.static(path.join(__dirname, '../../../clients/flutter/build/web')));

// Custom telemetry and HTTP request debugger middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`HTTP ${req.method} ${req.originalUrl} - Status: ${res.statusCode} - Duration: ${duration}ms`);
    if (req.method === 'POST') {
      const bodyCopy = { ...req.body };
      if (bodyCopy.password) bodyCopy.password = '[REDACTED]';
      if (bodyCopy.confirmPassword) bodyCopy.confirmPassword = '[REDACTED]';
      logger.info(`HTTP Payload`, bodyCopy);
    }
  });
  next();
});

// Main Service Routes
app.use('/api/users', userRoutes);
app.use('/api/telemetry', telemetryRoutes);
app.use('/api/curriculum', curriculumRoutes);
app.use('/api/questions', questionRoutes);

// Health Status Endpoint checking SQL and Document database layers
app.get('/api/health', async (req, res) => {
  try {
    const pgRes = await pgPool.query('SELECT NOW()');
    const mongoDb = getMongoDb();
    const mongoRes = await mongoDb.command({ ping: 1 });
    
    res.json({
      status: 'HEALTHY',
      postgres: pgRes.rows[0].now ? 'CONNECTED' : 'DOWN',
      mongodb: mongoRes.ok ? 'CONNECTED' : 'DOWN',
      timestamp: new Date()
    });
  } catch (error) {
    res.status(500).json({
      status: 'UNHEALTHY',
      error: error.message,
      timestamp: new Date()
    });
  }
});

// Catch-all route to serve the Flutter single-page app (index.html)
app.get('*', (req, res, next) => {
  if (req.url.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../../../clients/flutter/build/web/index.html'));
});

module.exports = app;
