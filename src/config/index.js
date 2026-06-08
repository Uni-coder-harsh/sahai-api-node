require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  
  // PostgreSQL Pool Configuration
  PG: {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    user: process.env.PG_USER || 'sahai_user',
    password: process.env.PG_PASSWORD || 'sahai_password',
    database: process.env.PG_DATABASE || 'sahai_db'
  },
  
  // Redis Event Ingestion Queue Configuration
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  TELEMETRY_QUEUE: 'telemetry_queue',
  
  // MongoDB Document Persistence Configuration
  MONGO_URI: process.env.MONGO_URI || 'mongodb://sahai_admin:sahai_admin_password@localhost:27017/sahai_mongo_db?authSource=admin'
};
