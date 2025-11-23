// init-db.js
require('dotenv').config();
const { Client } = require('pg');

async function main() {
  // Cliente siempre con SSL (Render PostgreSQL exige SSL)
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('✅ Conectado a PostgreSQL (init-db.js)');

    // SQL para crear la tabla si no existe
    const sql = `
      CREATE TABLE IF NOT EXISTS conversaciones (
        id SERIAL PRIMARY KEY,
        phone TEXT UNIQUE NOT NULL,
        name TEXT,
        messages JSONB NOT NULL DEFAULT '[]'::jsonb,
        last_update TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    await client.query(sql);
    console.log('✅ Tabla "conversaciones" lista (creada o ya existía)');
  } catch (err) {
    console.error('❌ Error en init-db.js:', err);
  } finally {
    await client.end();
    console.log('🔌 Conexión cerrada');
  }
}

main();
