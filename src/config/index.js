const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../ENV/.env') });

module.exports = {
  PORT: process.env.PORT || 3000,
  
  // PostgreSQL Pool Configuration
  PG: {
    host: process.env.PG_HOST,
    port: parseInt(process.env.PG_PORT || '5432', 10),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false
  },
  
  // Redis Event Ingestion Queue Configuration
  REDIS_URL: process.env.REDIS_URL,
  TELEMETRY_QUEUE: process.env.TELEMETRY_QUEUE || 'telemetry_queue',
  ENGINE_PYTHON_URL: process.env.ENGINE_PYTHON_URL || ((process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_SERVICE_NAME || process.env.RAILWAY_ENVIRONMENT_ID) ? 'http://sahai-engine-python.railway.internal:5000' : 'http://localhost:5000'),
  
  // MongoDB Document Persistence Configuration
  MONGO_URI: process.env.MONGO_URI
};
