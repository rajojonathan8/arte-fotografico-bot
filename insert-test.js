// insert-test.js
require('dotenv').config();
const { Pool } = require('pg');

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  try {
    const sql = `
      INSERT INTO conversaciones (phone, name, messages, last_update)
      VALUES (
        '50370000000',
        'Cliente de prueba',
        '[{"from":"cliente","text":"Hola!","timestamp":${Date.now()}}]',
        NOW()
      )
      ON CONFLICT (phone)
      DO NOTHING
    `;

    await pgPool.query(sql);
    console.log("✅ Conversación de prueba insertada.");

  } catch (err) {
    console.error("❌ Error insertando prueba:", err);
  } finally {
    await pgPool.end();
    console.log("Conexión cerrada");
  }
}

main();
