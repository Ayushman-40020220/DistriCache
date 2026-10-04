const { Pool } = require('pg');
const config = require('./index');
const logger = require('../utils/logger');

const pool = new Pool({
  connectionString: config.databaseUrl,
  min: config.dbPoolMin,
  max: config.dbPoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('connect', () => {
  logger.debug('New PostgreSQL client connected to pool');
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle PostgreSQL client', { error: err.message, stack: err.stack });
});

async function testConnection(retries = 5, delayMs = 2000) {
  for (let i = 1; i <= retries; i++) {
    try {
      const client = await pool.connect();
      const res = await client.query('SELECT NOW() AS connected_at, current_database() AS db');
      client.release();
      logger.info('PostgreSQL connection established successfully', {
        database: res.rows[0].db,
        time: res.rows[0].connected_at
      });
      return true;
    } catch (err) {
      logger.warn(`PostgreSQL connection attempt ${i}/${retries} failed: ${err.message}`);
      if (i === retries) {
        throw new Error(`Failed to connect to PostgreSQL after ${retries} attempts: ${err.message}`);
      }
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
}

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  testConnection
};
