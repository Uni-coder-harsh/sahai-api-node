const express = require('express');
const cors = require('cors');
const pgPool = require('./database/pg');
const { getMongoDb } = require('./database/mongo');

const userRoutes = require('./routes/user.routes');
const telemetryRoutes = require('./routes/telemetry.routes');
const curriculumRoutes = require('./routes/curriculum.routes');
const questionRoutes = require('./routes/question.routes');
const dashboardRoutes = require('./routes/dashboard.routes');

const path = require('path');
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
const logger = require('./utils/logger');

// Serve static assets from React dist
app.use(express.static(path.join(__dirname, '../../../clients/react/dist')));

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
app.use('/api/dashboard', dashboardRoutes);

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

// Network and environment diagnostics endpoint
app.get('/api/diagnose', async (req, res) => {
  const dns = require('dns').promises;
  const config = require('./config');
  const hosts = [
    'engine-python',
    'sahai-engine-python',
    'engine-python-production',
    'sahai-engine-python-production',
    'engine-python.railway.internal',
    'sahai-engine-python.railway.internal',
    'engine-python-production.railway.internal',
    'sahai-engine-python-production.railway.internal'
  ];
  
  const results = {};
  for (const host of hosts) {
    try {
      const addresses = await dns.lookup(host);
      results[host] = { status: 'RESOLVED', ip: addresses.address };
    } catch (err) {
      results[host] = { status: 'FAILED', error: err.message };
    }
  }
  
  const safeEnv = {};
  for (const key in process.env) {
    if (!key.toLowerCase().includes('password') && 
        !key.toLowerCase().includes('secret') && 
        !key.toLowerCase().includes('key') && 
        !key.toLowerCase().includes('uri') && 
        !key.toLowerCase().includes('url') &&
        !key.toLowerCase().includes('token')) {
      safeEnv[key] = process.env[key];
    }
  }
  
  res.json({
    results,
    env: safeEnv,
    currentConfig: {
      ENGINE_PYTHON_URL: config.ENGINE_PYTHON_URL
    }
  });
});

// Catch-all route to serve the React single-page app (index.html)
app.get('*', (req, res, next) => {
  if (req.url.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../../../clients/react/dist/index.html'));
});

module.exports = app;
