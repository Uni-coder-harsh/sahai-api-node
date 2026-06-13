const { Pool } = require('pg');
const config = require('../config');

const pgPool = new Pool({
  host: config.PG.host,
  port: config.PG.port,
  user: config.PG.user,
  password: config.PG.password,
  database: config.PG.database,
  ssl: config.PG.ssl,
  max: 25, // Optimized pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pgPool.on('connect', () => {
  console.log('[PG] PostgreSQL connection established with client pool.');
});

pgPool.on('error', (err) => {
  console.error('[PG] Idle PostgreSQL client error:', err);
});

module.exports = pgPool;
