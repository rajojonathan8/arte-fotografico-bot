// show-db.js
require('dotenv').config();
const { Pool } = require('pg');

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function main() {
  try {
    const result = await pgPool.query('SELECT COUNT(*) AS total FROM conversaciones');
    console.log('Total de conversaciones en Postgres:', result.rows[0].total);

    const r2 = await pgPool.query(
      'SELECT phone, name, last_update FROM conversaciones ORDER BY last_update DESC LIMIT 5'
    );
    console.log('Ejemplo de filas:', r2.rows);
  } catch (err) {
    console.error('❌ Error consultando Postgres:', err);
  } finally {
    await pgPool.end();
    console.log('Conexión cerrada');
  }
}

main();
