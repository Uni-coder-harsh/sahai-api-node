const express = require('express');
const cors = require('cors');
const pgPool = require('./database/pg');
const { getMongoDb } = require('./database/mongo');

const userRoutes = require('./routes/user.routes');
const telemetryRoutes = require('./routes/telemetry.routes');
const curriculumRoutes = require('./routes/curriculum.routes');

const app = express();

app.use(cors());
app.use(express.json());

// Main Service Routes
app.use('/api/users', userRoutes);
app.use('/api/telemetry', telemetryRoutes);
app.use('/api/curriculum', curriculumRoutes);

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

module.exports = app;
