// init-db.js
require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    console.log('✅ Conectado a PostgreSQL (init-db.js)');

    // 1) Tabla CONVERSACIONES (ya la tenías, la dejo igual)
    const sqlConversaciones = `
      CREATE TABLE IF NOT EXISTS conversaciones (
        id SERIAL PRIMARY KEY,
        phone TEXT UNIQUE NOT NULL,
        name TEXT,
        messages JSONB NOT NULL DEFAULT '[]'::jsonb,
        last_update TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    // 2) Tabla ÓRDENES_PERSONAS
    const sqlOrdenesPersonas = `
      CREATE TABLE IF NOT EXISTS ordenes_personas (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        numero_orden TEXT,
        numero_toma TEXT,
        fecha_toma DATE,
        fecha_entrega DATE,
        urgencia TEXT DEFAULT 'Normal',
        precio NUMERIC(10,2) DEFAULT 0,
        telefono TEXT,
        entrega TEXT DEFAULT 'Pendiente',
        abono NUMERIC(10,2) DEFAULT 0,
        pago_estado TEXT DEFAULT 'Pendiente',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    // 3) Tabla ÓRDENES_INSTITUCIONES
    const sqlOrdenesInstituciones = `
      CREATE TABLE IF NOT EXISTS ordenes_instituciones (
        id SERIAL PRIMARY KEY,
        institucion TEXT NOT NULL,
        nombre TEXT,
        seccion TEXT,
        paquete TEXT,
        toma_principal INTEGER DEFAULT 0,
        collage1 INTEGER DEFAULT 0,
        collage2 INTEGER DEFAULT 0,
        collage3 INTEGER DEFAULT 0,
        fecha_toma DATE,
        fecha_entrega DATE,
        telefono TEXT,
        urgencia TEXT DEFAULT 'Normal',
        precio NUMERIC(10,2) DEFAULT 0,
        abono NUMERIC(10,2) DEFAULT 0,
        pago_estado TEXT DEFAULT 'Pendiente',
        entrega TEXT DEFAULT 'Pendiente',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    // 4) Tabla CITAS
    const sqlCitas = `
      CREATE TABLE IF NOT EXISTS citas (
        id SERIAL PRIMARY KEY,
        cliente TEXT,
        telefono TEXT,
        sesion TEXT,
        fecha TIMESTAMPTZ,
        notas TEXT,
        estado TEXT DEFAULT 'Pendiente',
        origen TEXT DEFAULT 'manual',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

        // 5) Tabla EVENTO_PARTICIPANTES (para listados de facultades / grupos)
    const sqlEventoParticipantes = `
      CREATE TABLE IF NOT EXISTS evento_participantes (
        id SERIAL PRIMARY KEY,
        facultad TEXT,
        carrera TEXT,
        grupo_horario TEXT,
        numero_lista INTEGER,
        nombre TEXT NOT NULL,
        telefono TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

  // 5) 🔹 AÑADIR COLUMNA "impresos" SI NO EXISTE
    const sqlAlterImpresosPersonas = `
      ALTER TABLE ordenes_personas
      ADD COLUMN IF NOT EXISTS impresos boolean DEFAULT false;
    `;

    const sqlAlterImpresosInstituciones = `
      ALTER TABLE ordenes_instituciones
      ADD COLUMN IF NOT EXISTS impresos boolean DEFAULT false;
    `;
      // 🔹 NUEVO: columnas extra para órdenes de personas
    const sqlAlterEventoPersonas = `
      ALTER TABLE ordenes_personas
      ADD COLUMN IF NOT EXISTS evento TEXT;
    `;

    const sqlAlterAtendidoPorPersonas = `
      ALTER TABLE ordenes_personas
      ADD COLUMN IF NOT EXISTS atendido_por TEXT;
    `;
     // 5) 🔹 Columnas extra en ordenes_personas (evento / atendido_por)
    const sqlAlterEvento = `
      ALTER TABLE ordenes_personas
      ADD COLUMN IF NOT EXISTS evento TEXT;
    `;

    const sqlAlterAtendidoPor = `
      ALTER TABLE ordenes_personas
      ADD COLUMN IF NOT EXISTS atendido_por TEXT;
    `;

    // 6) 🔹 Tabla de detalle tipo factura para personas
    const sqlOrdenesPersonasDetalle = `
      CREATE TABLE IF NOT EXISTS ordenes_personas_detalle (
        id SERIAL PRIMARY KEY,
        orden_persona_id INTEGER NOT NULL REFERENCES ordenes_personas(id) ON DELETE CASCADE,
        descripcion TEXT NOT NULL,
        cantidad INTEGER NOT NULL DEFAULT 1,
        precio_unitario NUMERIC(10,2) NOT NULL DEFAULT 0,
        subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;
      

    await client.query(sqlConversaciones);
    console.log('🟢 Tabla "conversaciones" OK');

    await client.query(sqlOrdenesPersonas);
    console.log('🟢 Tabla "ordenes_personas" OK');

    await client.query(sqlOrdenesInstituciones);
    console.log('🟢 Tabla "ordenes_instituciones" OK');
      // 👇 NUEVO
    await client.query(sqlAlterEvento);
    await client.query(sqlAlterAtendidoPor);
    console.log('🟢 Columnas evento / atendido_por OK');

    await client.query(sqlOrdenesPersonasDetalle);
    console.log('🟢 Tabla "ordenes_personas_detalle" OK');

    // Ya lo tenías:
    await client.query(sqlAlterImpresosPersonas);
    await client.query(sqlAlterImpresosInstituciones);
    console.log('🟢 Columnas "impresos" OK');
    await client.query(sqlCitas);
    console.log('🟢 Tabla "citas" OK');
        // 👇 NUEVO: ejecutar los ALTER
    await client.query(sqlAlterImpresosPersonas);
    await client.query(sqlAlterImpresosInstituciones);
    console.log('🟢 Columnas "impresos" OK');

        // 👇 NUEVO: ejecutar los ALTER
    await client.query(sqlAlterImpresosPersonas);
    await client.query(sqlAlterImpresosInstituciones);
    console.log('🟢 Columnas "impresos" OK');

    await client.query(sqlAlterEventoPersonas);
    await client.query(sqlAlterAtendidoPorPersonas);
    console.log('🟢 Columnas "evento" y "atendido_por" OK');


        await client.query(sqlEventoParticipantes);
    console.log('🟢 Tabla "evento_participantes" OK');


        // 👇 NUEVO: ejecutar los ALTER
    await client.query(sqlAlterImpresosPersonas);
    await client.query(sqlAlterImpresosInstituciones);
    console.log('🟢 Columnas "impresos" OK');

    console.log('✅ init-db.js terminado sin errores');
  } catch (err) {
    console.error('❌ Error en init-db.js:', err);
  } finally {
    await client.end();
    console.log('🔌 Conexión cerrada (init-db.js)');
  }
}

main();
