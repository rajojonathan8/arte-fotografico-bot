require('dotenv').config();
const { Client } = require('pg');

async function testConnection() {
  try {
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    });

    await client.connect();
    console.log("✅ Conexión exitosa a PostgreSQL!");
    await client.end();
  } catch (err) {
    console.error("❌ Error conectando a PostgreSQL:", err.message);
  }
}

testConnection();
