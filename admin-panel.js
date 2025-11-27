// admin-panel.js
const path = require('path');
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

// ============================================================================
// RUTAS Y HELPERS COMPARTIDOS (data/…)
// ============================================================================

// Usamos la misma carpeta data que index.js
const DATA_DIR = path.join(process.cwd(), 'data');
const CONV_PATH = path.join(DATA_DIR, 'conversaciones.json');
const ORD_INST_PATH = path.join(DATA_DIR, 'ordenes-instituciones.json');
const ORD_PER_PATH = path.join(DATA_DIR, 'ordenes-personas.json');
const CITAS_PATH = path.join(DATA_DIR, 'citas.json');

// ============================================================================
// 🔌 Conexión PostgreSQL (igual que en index.js)
// ============================================================================
require('dotenv').config();
const { Pool } = require('pg');

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Helper para SELECT
async function dbSelect(query, params = []) {
  const { rows } = await db.query(query, params);
  return rows;
}

// Helper para ejecutar INSERT/UPDATE/DELETE
async function dbExec(query, params = []) {
  await db.query(query, params);
}

// Carpeta de uploads para OCR
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Configuración de multer (subida de una sola imagen)
const upload = multer({
  dest: UPLOADS_DIR,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
});

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureDataFile(filePath, initialJson = '[]') {
  ensureDataDir();
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, initialJson, 'utf8');
  }
}

function readJson(filePath, fallback = []) {
  try {
    ensureDataFile(filePath, JSON.stringify(fallback, null, 2));
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    console.error('❌ Error leyendo', filePath, e.message);
    return fallback;
  }
}

function writeJson(filePath, data) {
  try {
    ensureDataFile(filePath);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('❌ Error guardando', filePath, e.message);
  }
}

// Conversaciones para el panel de chat
function loadConversacionesPanel() {
  return readJson(CONV_PATH, []);
}

// ===== Helpers de pago ======================================================

function computePagoEstado(precio, abono) {
  const p = Number(precio) || 0;
  const a = Number(abono) || 0;

  if (p <= 0 && a <= 0) return 'Pendiente';
  if (a >= p && p > 0) return 'Pagado';
  if (a > 0 && a < p) return 'Abono';
  return 'Pendiente';
}

function derivePagoEstado(record) {
  const stored = (record.pago_estado || '').toLowerCase();
  if (stored === 'pagado') return 'Pagado';
  if (stored === 'abono') return 'Abono';
  if (stored === 'pendiente') return 'Pendiente';

  // Si no hay texto guardado, calculamos por números como respaldo
  return computePagoEstado(record.precio, record.abono);
}

// Intenta obtener el abono desde cualquier campo que tenga la palabra "abono"
function getAbonoFromBody(datos) {
  if (!datos) return 0;

  let abonoNum = 0;

  for (const [key, value] of Object.entries(datos)) {
    const k = key.toLowerCase();
    // ignoramos cosas como "estado_pago" pero aceptamos abono, abonado, abono_inicial, etc.
    if (k.includes('abono') && !k.includes('estado')) {
      const n = Number(value);
      if (!isNaN(n)) {
        abonoNum = n;
        break;
      }
    }
  }

  return abonoNum;
}

// Resumen de pagos (para la cajita de totales)
function calcularResumen(lista) {
  const datos = Array.isArray(lista) ? lista : [];

  let totalPrecio = 0;
  let totalAbono = 0;
  let totalSaldo = 0;

  datos.forEach((o) => {
    const precio = Number(o.precio || 0);
    const abono = Number(o.abono || 0);
    const saldo = Math.max(precio - abono, 0);

    totalPrecio += precio;
    totalAbono += abono;
    totalSaldo += saldo;
  });

  return {
    totalPrecio,
    totalAbono,
    totalSaldo,
    cantidad: datos.length,
  };
}

// ============================================================================
// MÓDULO PRINCIPAL
// ============================================================================

function mountAdmin(app) {
  const router = express.Router();

  // ===== Sesión (para que recuerde el login)
  app.use(
    session({
      secret: process.env.SESSION_SECRET || 'arte-fotografico-super-secreto',
      resave: false,
      saveUninitialized: false,
    })
  );

  // ===== Motor de vistas (EJS) y carpeta de vistas
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // ===== Archivos estáticos del panel (css, imágenes, etc.)
  app.use('/admin-public', express.static(path.join(__dirname, 'admin-public')));

  // ===== PIN para empleados (todos comparten el mismo)
  const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

  // ---------------------------------------------------------------------------
  // Helpers de auth
  // ---------------------------------------------------------------------------
  function requireAuth(req, res, next) {
    if (req.session && req.session.isAdmin) return next();
    return res.redirect('/admin/login');
  }

  // ---------------------------------------------------------------------------
  // LOGIN
  // ---------------------------------------------------------------------------
  router.get('/login', (req, res) => {
    res.render('login', { error: null });
  });

  router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
    const { pin } = req.body || {};
    if (pin === ADMIN_PIN) {
      req.session.isAdmin = true;
      return res.redirect('/admin');
    }
    return res.render('login', { error: 'PIN incorrecto. Intenta de nuevo.' });
  });

  // ---------------------------------------------------------------------------
  // DASHBOARD PRINCIPAL /admin
  // ---------------------------------------------------------------------------

  const cards = [
    {
      href: '/admin/chat',
      icon: '💬',
      title: 'Chat con clientes',
      desc: 'Ver mensajes entrantes de WhatsApp y responder desde el panel.',
    },
    {
      href: '/admin/ordenes',
      icon: '📒',
      title: 'Órdenes y libros',
      desc: 'Registrar órdenes de instituciones y personas, marcar urgencias y entregas.',
    },
    {
      href: '/admin/herramientas',
      icon: '🧠',
      title: 'Herramientas IA',
      desc: 'Subir listas de estudiantes y convertirlas a texto limpio automáticamente.',
    },
    {
      href: '/admin/citas',
      icon: '📅',
      title: 'Citas',
      desc: 'Ver, filtrar y actualizar el estado de las citas.',
    },
  ];

  router.get('/', requireAuth, async (req, res) => {
    try {
      // 🔹 Cargamos todas las órdenes desde PostgreSQL
      const ordenesPersonasAll = await dbSelect(
        'SELECT * FROM ordenes_personas ORDER BY fecha_entrega ASC NULLS LAST'
      );
      const ordenesInstitucionesAll = await dbSelect(
        'SELECT * FROM ordenes_instituciones ORDER BY fecha_entrega ASC NULLS LAST'
      );

      const totalPersonas = ordenesPersonasAll.length;
      const totalInstituciones = ordenesInstitucionesAll.length;
      const totalOrdenes = totalPersonas + totalInstituciones;

      const resumenPersonas = calcularResumen(ordenesPersonasAll);
      const resumenInstituciones = calcularResumen(ordenesInstitucionesAll);

      const facturadoTotal =
        (resumenPersonas.totalPrecio || 0) +
        (resumenInstituciones.totalPrecio || 0);
      const abonadoTotal =
        (resumenPersonas.totalAbono || 0) +
        (resumenInstituciones.totalAbono || 0);
      const saldoTotal =
        (resumenPersonas.totalSaldo || 0) +
        (resumenInstituciones.totalSaldo || 0);

      const resumenGlobal = {
        facturadoTotal,
        abonadoTotal,
        saldoTotal,
      };

      // 🔹 Citas desde JSON
      const listaCitas = readJson(CITAS_PATH, []);
      const hoyStr = new Date().toISOString().slice(0, 10);

      const citasHoy = listaCitas.filter(
        (c) => (c.fecha || '').slice(0, 10) === hoyStr
      );
      const citasPendientes = listaCitas.filter(
        (c) => (c.estado || 'Pendiente') === 'Pendiente'
      );

      const resumenCitas = {
        total: listaCitas.length,
        hoy: citasHoy.length,
        pendientes: citasPendientes.length,
      };

      // 🔹 Próximas entregas (siguientes 3 días)
        // ================== PRÓXIMAS ENTREGAS (3 días) ==================
  const hoy = new Date();
  const limite = new Date();
  limite.setDate(hoy.getDate() + 3);

  const hoyISO = hoy.toISOString().slice(0, 10);
  const limISO = limite.toISOString().slice(0, 10);

  // Personas
  const proximasPersonas = await dbSelect(
    `SELECT id, nombre, fecha_entrega, precio, abono, urgencia
     FROM ordenes_personas
     WHERE fecha_entrega IS NOT NULL
       AND fecha_entrega::date BETWEEN $1 AND $2
       AND (entrega IS NULL OR entrega <> 'Entregado')
     ORDER BY fecha_entrega ASC
     LIMIT 20`,
    [hoyISO, limISO]
  );

  // Instituciones
  const proximasInstituciones = await dbSelect(
    `SELECT id, institucion, fecha_entrega, precio, abono, urgencia
     FROM ordenes_instituciones
     WHERE fecha_entrega IS NOT NULL
       AND fecha_entrega::date BETWEEN $1 AND $2
       AND (entrega IS NULL OR entrega <> 'Entregado')
     ORDER BY fecha_entrega ASC
     LIMIT 20`,
    [hoyISO, limISO]
  );

  const proximasEntregas = [
    ...proximasPersonas.map(o => ({
      tipo: 'persona',
      id: o.id,
      nombre: o.nombre,
      fecha_entrega: o.fecha_entrega,
      saldo: Math.max(Number(o.precio || 0) - Number(o.abono || 0), 0),
      urgencia: o.urgencia || 'Normal',
    })),
    ...proximasInstituciones.map(o => ({
      tipo: 'institucion',
      id: o.id,
      nombre: o.institucion,
      fecha_entrega: o.fecha_entrega,
      saldo: Math.max(Number(o.precio || 0) - Number(o.abono || 0), 0),
      urgencia: o.urgencia || 'Normal',
    })),
  ].sort((a, b) => {
    const da = new Date(a.fecha_entrega || a.fecha);
    const dbb = new Date(b.fecha_entrega || b.fecha);
    return da - dbb;
  });


      res.render('admin', {
        title: 'Panel de administración',
        cards,
        totalOrdenes,
        totalPersonas,
        totalInstituciones,
        resumenPersonas,
        resumenInstituciones,
        resumenGlobal,
        resumenCitas,
        proximasEntregas,
      });
    } catch (err) {
      console.error('❌ Error en dashboard /admin:', err);

      // Fallback por si algo falla
      res.render('admin', {
        title: 'Panel de administración',
        cards,
        totalOrdenes: 0,
        totalPersonas: 0,
        totalInstituciones: 0,
        resumenPersonas: calcularResumen([]),
        resumenInstituciones: calcularResumen([]),
        resumenGlobal: {
          facturadoTotal: 0,
          abonadoTotal: 0,
          saldoTotal: 0,
        },
        resumenCitas: {
          total: 0,
          hoy: 0,
          pendientes: 0,
        },
        proximasEntregas: [],
      });
    }
  });

  // ---------------------------------------------------------------------------
  // CHAT (lee data/conversaciones.json)
  // ---------------------------------------------------------------------------
  router.get('/chat', requireAuth, (req, res) => {
    const conversations = loadConversacionesPanel();

    res.render('chat', {
      title: 'Chat con clientes',
      conversations,
    });
  });

  // ---------------------------------------------------------------------------
  // ÓRDENES Y LIBROS (con filtros avanzados)
  // ---------------------------------------------------------------------------
  router.get('/ordenes', requireAuth, async (req, res) => {
    const tab = req.query.tab === 'personas' ? 'personas' : 'instituciones';

    // Filtros recibidos del formulario
    const fechaDesde = (req.query.fecha_desde || '').trim();
    const fechaHasta = (req.query.fecha_hasta || '').trim();
    const busqueda = (req.query.q || '').trim().toLowerCase();
    const filtroUrg = (req.query.urgencia || '').trim();
    const filtroEnt = (req.query.entrega || '').trim();
    const filtroPago = (req.query.pago || '').trim();

    // 🔵 Cargar desde PostgreSQL
    let ordenesInstitucionesAll = [];
    let ordenesPersonasAll = [];

    try {
      ordenesInstitucionesAll = await dbSelect(
        'SELECT * FROM ordenes_instituciones ORDER BY id DESC'
      );
      ordenesPersonasAll = await dbSelect(
        'SELECT * FROM ordenes_personas ORDER BY id DESC'
      );
    } catch (e) {
      console.error('❌ Error cargando órdenes desde PostgreSQL:', e);
    }

function normalizarFechaFiltro(valor) {
  if (!valor) return '';

  // Si ya es Date (por venir de PostgreSQL)
  if (valor instanceof Date) {
    if (isNaN(valor.getTime())) return '';
    return valor.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  // Si viene como texto (por cosas viejas / JSON)
  const d = new Date(valor);
  if (isNaN(d.getTime())) {
    // último intento: tomar los primeros 10 caracteres del valor como string
    return String(valor).slice(0, 10);
  }

  return d.toISOString().slice(0, 10);
}

    function pasaFiltrosGenerales(o) {
  // 🔹 Fecha de toma
  if (fechaDesde || fechaHasta) {
    const f = normalizarFechaFiltro(o.fecha_toma);
    if (!f) return false;

    if (fechaDesde && f < fechaDesde) return false;
    if (fechaHasta && f > fechaHasta) return false;
  }

  // 🔹 Texto libre
  if (busqueda) {
    const texto = [
      o.institucion,
      o.seccion,
      o.paquete,
      o.nombre,
      o.telefono,
      o.numero_orden,
      o.n_orden,
      o.numero_toma,
      o.n_toma,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (!texto.includes(busqueda)) return false;
  }

  // 🔹 Urgencia
  if (filtroUrg) {
    const u = (o.urgencia || 'Normal').toLowerCase();
    if (u !== filtroUrg.toLowerCase()) return false;
  }

  // 🔹 Entrega
  if (filtroEnt) {
    const e = (o.entrega || o.estado_entrega || 'Pendiente').toLowerCase();
    if (e !== filtroEnt.toLowerCase()) return false;
  }

  // 🔹 Pago
  if (filtroPago) {
    const p = derivePagoEstado(o).toLowerCase();
    if (p !== filtroPago.toLowerCase()) return false;
  }

  return true;
}


    const ordenesInstituciones = (ordenesInstitucionesAll || []).filter(
      pasaFiltrosGenerales
    );
    const ordenesPersonas = (ordenesPersonasAll || []).filter(
      pasaFiltrosGenerales
    );

    // Resúmenes de pago
    const resumenInstituciones = calcularResumen(ordenesInstituciones);
    const resumenPersonas = calcularResumen(ordenesPersonas);

    res.render('ordenes', {
      title: 'Órdenes y libros',
      tab,
      ordenesInstituciones,
      ordenesPersonas,
      fechaDesde,
      fechaHasta,
      busqueda,
      filtroUrg,
      filtroEnt,
      filtroPago,
      resumenInstituciones,
      resumenPersonas,
    });
  });

  // ---------------------------------------------------------------------------
  // NUEVA ORDEN — INSTITUCIÓN
  // ---------------------------------------------------------------------------
  router.get('/ordenes/nueva-institucion', requireAuth, (req, res) => {
    res.render('ordenes-nueva', {
      title: 'Nueva orden — institución',
    });
  });

  router.post(
    '/ordenes/nueva-institucion',
    requireAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const datos = req.body || {};

      const precioNum = Number(datos.precio) || 0;
      let abonoNum = Number(datos.abono_inicial || 0);
      let pagoEstado = datos.pago_estado || 'Pendiente';

      // Ajuste de coherencia
      if (pagoEstado === 'Pagado' && precioNum > 0) {
        abonoNum = precioNum;
      } else {
        pagoEstado = computePagoEstado(precioNum, abonoNum);
      }

      try {
        await dbExec(
          `
        INSERT INTO ordenes_instituciones (
          nombre, institucion, seccion, paquete,
          toma_principal, collage1, collage2, collage3,
          fecha_toma, fecha_entrega, telefono,
          entrega, urgencia,
          precio, abono, pago_estado
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        `,
          [
            datos.nombre || '',
            datos.institucion || '',
            datos.seccion || '',
            datos.paquete || '',
            Number(datos.toma_principal || 0),
            Number(datos.collage1 || 0),
            Number(datos.collage2 || 0),
            Number(datos.collage3 || 0),
            datos.fecha_toma || null,
            datos.fecha_entrega || null,
            datos.telefono || '',
            datos.entrega || 'Pendiente',
            datos.urgencia || 'Normal',
            precioNum,
            abonoNum,
            pagoEstado,
          ]
        );

        console.log('💾 Nueva orden de institución guardada en PostgreSQL');
      } catch (err) {
        console.error(
          '❌ Error guardando orden institución en PostgreSQL:',
          err
        );
      }

      res.redirect('/admin/ordenes?tab=instituciones');
    }
  );

  // ---------------------------------------------------------------------------
  // NUEVA ORDEN — PERSONA
  // ---------------------------------------------------------------------------
  router.get('/ordenes/nueva-persona', requireAuth, (req, res) => {
    res.render('ordenes-nueva-persona.ejs', {
      title: 'Nueva orden (persona)',
    });
  });

  router.post(
    '/ordenes/nueva-persona',
    requireAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const datos = req.body || {};

      const {
        nombre,
        numero_orden,
        numero_toma,
        fecha_toma,
        fecha_entrega,
        urgencia,
        precio,
        telefono,
        estado_entrega,
        pago_estado,
      } = datos;

      const precioNum = Number(precio) || 0;
      let abonoNum = getAbonoFromBody(datos);
      let pagoEstado = pago_estado || 'Pendiente';

      if (pagoEstado === 'Pagado' && precioNum > 0) {
        abonoNum = precioNum;
      }

      if (abonoNum > 0 && abonoNum < precioNum && pagoEstado !== 'Pagado') {
        pagoEstado = 'Abono';
      }

      if (abonoNum === 0 && pagoEstado === 'Abono') {
        pagoEstado = 'Pendiente';
      }

      try {
        await dbExec(
          `
        INSERT INTO ordenes_personas (
          nombre,
          numero_orden,
          numero_toma,
          fecha_toma,
          fecha_entrega,
          urgencia,
          precio,
          telefono,
          entrega,
          abono,
          pago_estado
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `,
          [
            nombre || '',
            numero_orden || '',
            numero_toma || '',
            fecha_toma || null,
            fecha_entrega || null,
            urgencia || 'Normal',
            precioNum,
            telefono || '',
            estado_entrega || 'Pendiente',
            abonoNum,
            pagoEstado,
          ]
        );

        console.log('💾 Nueva orden persona guardada en PostgreSQL');
      } catch (err) {
        console.error('❌ Error guardando orden PERSONA en PostgreSQL:', err);
      }

      res.redirect('/admin/ordenes?tab=personas');
    }
  );

  // ---------------------------------------------------------------------------
  // EDITAR ORDEN — INSTITUCIÓN
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
// EDITAR ORDEN — INSTITUCIÓN
// ---------------------------------------------------------------------------
router.get(
  '/ordenes/institucion/:id/editar',
  requireAuth,
  async (req, res) => {
    const id = Number(req.params.id);

    if (!id || id <= 0) {
      return res.redirect('/admin/ordenes?tab=instituciones');
    }

    try {
      const rows = await dbSelect(
        'SELECT * FROM ordenes_instituciones WHERE id = $1',
        [id]
      );

      if (!rows.length) {
        return res.redirect('/admin/ordenes?tab=instituciones');
      }

      const orden = rows[0];

      // 👇 usa la vista que ya tenías para instituciones
      res.render('ordenes-editar-institucion.ejs', {
        title: 'Editar orden — institución',
        idx: id,   // la vista suele usar idx en la acción del form
        orden,
      });
    } catch (err) {
      console.error('❌ Error cargando orden institución:', err);
      return res.redirect('/admin/ordenes?tab=instituciones');
    }
  }
);


  router.post(
    '/ordenes/institucion/:id/editar',
    requireAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const id = Number(req.params.id);
      const datos = req.body || {};

      if (!id || id <= 0) {
        return res.redirect('/admin/ordenes?tab=instituciones');
      }

      const precioNum = Number(datos.precio) || 0;
      const abonoNum = Number(datos.abono) || 0;
      const pagoEstado = computePagoEstado(precioNum, abonoNum);

      try {
        await dbExec(
          `
        UPDATE ordenes_instituciones
        SET
          nombre = $1,
          institucion = $2,
          seccion = $3,
          paquete = $4,
          toma_principal = $5,
          collage1 = $6,
          collage2 = $7,
          collage3 = $8,
          fecha_toma = $9,
          fecha_entrega = $10,
          telefono = $11,
          entrega = $12,
          urgencia = $13,
          precio = $14,
          abono = $15,
          pago_estado = $16
        WHERE id = $17
        `,
          [
            datos.nombre || '',
            datos.institucion || '',
            datos.seccion || '',
            datos.paquete || '',
            Number(datos.toma_principal || 0),
            Number(datos.collage1 || 0),
            Number(datos.collage2 || 0),
            Number(datos.collage3 || 0),
            datos.fecha_toma || null,
            datos.fecha_entrega || null,
            datos.telefono || '',
            datos.entrega || 'Pendiente',
            datos.urgencia || 'Normal',
            precioNum,
            abonoNum,
            pagoEstado,
            id,
          ]
        );

        console.log('💾 Orden institución actualizada en PostgreSQL');
      } catch (err) {
        console.error('❌ Error actualizando orden institución:', err);
      }

      res.redirect('/admin/ordenes?tab=instituciones');
    }
  );

  // ---------------------------------------------------------------------------
  // EDITAR ORDEN — PERSONA
  // ---------------------------------------------------------------------------

  // GET - Editar persona
  router.get('/ordenes/persona/:id/editar', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);

      const rows = await dbSelect(
        'SELECT * FROM ordenes_personas WHERE id = $1',
        [id]
      );

      if (!rows.length) {
        return res.status(404).send('Orden no encontrada');
      }

      const orden = rows[0];

      res.render('ordenes-editar-persona', {
        title: 'Editar orden — persona',
        idx: id,
        orden,
      });
    } catch (err) {
      console.error('❌ Error GET editar persona:', err);
      res.status(500).send('Error interno');
    }
  });

  // POST - Guardar edición persona
  router.post(
    '/ordenes/persona/:id/editar',
    requireAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      try {
        const id = Number(req.params.id);

        const {
          nombre,
          numero_orden,
          numero_toma,
          fecha_toma,
          fecha_entrega,
          urgencia,
          precio,
          abono,
          telefono,
          estado_entrega,
        } = req.body;

        await dbExec(
          `UPDATE ordenes_personas 
       SET nombre=$1,
           numero_orden=$2,
           numero_toma=$3,
           fecha_toma=$4,
           fecha_entrega=$5,
           urgencia=$6,
           precio=$7,
           abono=$8,
           telefono=$9,
           entrega=$10
       WHERE id = $11`,
          [
            nombre,
            numero_orden,
            numero_toma,
            fecha_toma || null,
            fecha_entrega || null,
            urgencia,
            Number(precio) || 0,
            Number(abono) || 0,
            telefono,
            estado_entrega,
            id,
          ]
        );

        res.redirect(`/admin/ordenes?tab=personas`);
      } catch (err) {
        console.error('❌ Error POST editar persona:', err);
        res.status(500).send('Error interno');
      }
    }
  );

  // ---------------------------------------------------------------------------
  // ELIMINAR ORDEN — INSTITUCIÓN
  // ---------------------------------------------------------------------------
  router.post(
    '/ordenes/institucion/:id/eliminar',
    requireAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const id = Number(req.params.id);

      try {
        await dbExec('DELETE FROM ordenes_instituciones WHERE id = $1', [id]);
      } catch (e) {
        console.error('❌ Error eliminando institucion:', e);
      }

      res.redirect('/admin/ordenes?tab=instituciones');
    }
  );

  // ---------------------------------------------------------------------------
  // ELIMINAR ORDEN — PERSONA
  // ---------------------------------------------------------------------------
  router.post(
    '/ordenes/persona/:id/eliminar',
    requireAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const id = Number(req.params.id);

      try {
        await dbExec('DELETE FROM ordenes_personas WHERE id = $1', [id]);
      } catch (e) {
        console.error('❌ Error eliminando persona:', e);
      }

      res.redirect('/admin/ordenes?tab=personas');
    }
  );

  // ---------------------------------------------------------------------------
  // DETALLE ORDEN — INSTITUCIÓN
  // ---------------------------------------------------------------------------
  router.get(
    '/ordenes/institucion/:id',
    requireAuth,
    async (req, res) => {
      const id = Number(req.params.id);

      try {
        const rows = await dbSelect(
          'SELECT * FROM ordenes_instituciones WHERE id = $1',
          [id]
        );

        if (!rows.length) {
          return res.redirect('/admin/ordenes?tab=instituciones');
        }

        const orden = rows[0];

        res.render('orden-detalle', {
          title: 'Detalle de orden — institución',
          tipo: 'institucion',
          idx: id,
          orden,
        });
      } catch (e) {
        console.error('❌ Error detalle institucion:', e);
        res.redirect('/admin/ordenes?tab=instituciones');
      }
    }
  );

  // ---------------------------------------------------------------------------
  // DETALLE ORDEN — PERSONA
  // ---------------------------------------------------------------------------
 // ---------------------------------------------------------------------------
// DETALLE ORDEN — PERSONA (PostgreSQL)
// ---------------------------------------------------------------------------
router.get(
  '/ordenes/persona/:id',
  requireAuth,
  async (req, res) => {
    const id = Number(req.params.id);

    if (!id || id <= 0) {
      return res.redirect('/admin/ordenes?tab=personas');
    }

    try {
      const rows = await dbSelect(
        'SELECT * FROM ordenes_personas WHERE id = $1',
        [id]
      );

      if (!rows.length) {
        return res.redirect('/admin/ordenes?tab=personas');
      }

      const orden = rows[0];

      res.render('orden-detalle', {
        title: 'Detalle de orden — persona',
        tipo: 'persona',
        idx: id,
        orden,
      });
    } catch (err) {
      console.error('❌ Error detalle persona:', err);
      res.redirect('/admin/ordenes?tab=personas');
    }
  }
);


  // ---------------------------------------------------------------------------
  // CAMBIAR ESTADO DE ENTREGA — PERSONAS
  // ---------------------------------------------------------------------------
  router.post(
    '/ordenes/persona/entrega',
    requireAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const id = Number(req.body.id);
      const nuevoEstado =
        req.body.estado === 'Entregado' ? 'Entregado' : 'Pendiente';

      try {
        await dbExec(
          'UPDATE ordenes_personas SET entrega = $1 WHERE id = $2',
          [nuevoEstado, id]
        );
      } catch (e) {
        console.error('❌ Error cambiando entrega persona:', e);
      }

      res.redirect('/admin/ordenes?tab=personas');
    }
  );

  // ---------------------------------------------------------------------------
  // CAMBIAR ESTADO DE ENTREGA — INSTITUCIONES
  // ---------------------------------------------------------------------------
  router.post(
    '/ordenes/institucion/entrega',
    requireAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const id = Number(req.body.id);
      const nuevoEstado =
        req.body.estado === 'Entregado' ? 'Entregado' : 'Pendiente';

      try {
        await dbExec(
          'UPDATE ordenes_instituciones SET entrega = $1 WHERE id = $2',
          [nuevoEstado, id]
        );
      } catch (e) {
        console.error('❌ Error cambiando entrega institucion:', e);
      }

      res.redirect('/admin/ordenes?tab=instituciones');
    }
  );

  // ---------------------------------------------------------------------------
  // ABONAR / MARCAR PAGADO — PERSONAS
  // ---------------------------------------------------------------------------
  router.post(
    '/ordenes/persona/:id/abonar',
    requireAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const id = Number(req.params.id);
      const monto = Number(req.body.monto) || 0;

      if (monto <= 0) {
        return res.redirect('/admin/ordenes?tab=personas');
      }

      try {
        const rows = await dbSelect(
          'SELECT * FROM ordenes_personas WHERE id = $1',
          [id]
        );
        if (!rows.length) {
          return res.redirect('/admin/ordenes?tab=personas');
        }

        const item = rows[0];
        const precio = Number(item.precio) || 0;
        const abonoActual = Number(item.abono) || 0;
        let nuevoAbono = abonoActual + monto;
        if (nuevoAbono > precio) nuevoAbono = precio;

        const pagoEstado = computePagoEstado(precio, nuevoAbono);

        await dbExec(
          'UPDATE ordenes_personas SET abono = $1, pago_estado = $2 WHERE id = $3',
          [nuevoAbono, pagoEstado, id]
        );
      } catch (e) {
        console.error('❌ Error abonar persona:', e);
      }

      res.redirect('/admin/ordenes?tab=personas');
    }
  );

  router.post(
    '/ordenes/persona/:id/marcar-pagado',
    requireAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const id = Number(req.params.id);

      try {
        const rows = await dbSelect(
          'SELECT * FROM ordenes_personas WHERE id = $1',
          [id]
        );
        if (!rows.length) {
          return res.redirect('/admin/ordenes?tab=personas');
        }

        const item = rows[0];
        const precio = Number(item.precio) || 0;

        await dbExec(
          'UPDATE ordenes_personas SET abono = $1, pago_estado = $2 WHERE id = $3',
          [precio, 'Pagado', id]
        );
      } catch (e) {
        console.error('❌ Error marcar pagado persona:', e);
      }

      res.redirect('/admin/ordenes?tab=personas');
    }
  );

  // ---------------------------------------------------------------------------
  // ABONAR / MARCAR PAGADO — INSTITUCIONES
  // ---------------------------------------------------------------------------
  router.post(
    '/ordenes/institucion/:id/abonar',
    requireAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const id = Number(req.params.id);
      const monto = Number(req.body.monto) || 0;

      if (monto <= 0) {
        return res.redirect('/admin/ordenes?tab=instituciones');
      }

      try {
        const rows = await dbSelect(
          'SELECT * FROM ordenes_instituciones WHERE id = $1',
          [id]
        );
        if (!rows.length) {
          return res.redirect('/admin/ordenes?tab=instituciones');
        }

        const item = rows[0];
        const precio = Number(item.precio) || 0;
        const abonoActual = Number(item.abono) || 0;
        let nuevoAbono = abonoActual + monto;
        if (nuevoAbono > precio) nuevoAbono = precio;

        const pagoEstado = computePagoEstado(precio, nuevoAbono);

        await dbExec(
          'UPDATE ordenes_instituciones SET abono = $1, pago_estado = $2 WHERE id = $3',
          [nuevoAbono, pagoEstado, id]
        );
      } catch (e) {
        console.error('❌ Error abonar institucion:', e);
      }

      res.redirect('/admin/ordenes?tab=instituciones');
    }
  );

  router.post(
    '/ordenes/institucion/:id/marcar-pagado',
    requireAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const id = Number(req.params.id);

      try {
        const rows = await dbSelect(
          'SELECT * FROM ordenes_instituciones WHERE id = $1',
          [id]
        );
        if (!rows.length) {
          return res.redirect('/admin/ordenes?tab=instituciones');
        }

        const item = rows[0];
        const precio = Number(item.precio) || 0;

        await dbExec(
          'UPDATE ordenes_instituciones SET abono = $1, pago_estado = $2 WHERE id = $3',
          [precio, 'Pagado', id]
        );
      } catch (e) {
        console.error('❌ Error marcar pagado institucion:', e);
      }

      res.redirect('/admin/ordenes?tab=instituciones');
    }
  );

  // ---------------------------------------------------------------------------
  // RECIBO — PERSONA (HTML imprimible media carta)
  // ---------------------------------------------------------------------------
  router.get('/ordenes/persona/:id/recibo', requireAuth, async (req, res) => {
    const id = Number(req.params.id);

    try {
      const rows = await dbSelect(
        'SELECT * FROM ordenes_personas WHERE id = $1',
        [id]
      );
      if (!rows.length) {
        return res.redirect('/admin/ordenes?tab=personas');
      }

      const orden = rows[0];
      const precio = Number(orden.precio || 0);
      const abono = Number(orden.abono || 0);
      const saldo = Math.max(precio - abono, 0);
      const pagoEstado = derivePagoEstado(orden);

      res.render('orden-recibo.ejs', {
        title: 'Recibo — persona',
        tipo: 'persona',
        idx: id,
        orden,
        precio,
        abono,
        saldo,
        pagoEstado,
      });
    } catch (e) {
      console.error('❌ Error recibo persona:', e);
      res.redirect('/admin/ordenes?tab=personas');
    }
  });

  // ---------------------------------------------------------------------------
  // RECIBO — INSTITUCIÓN (HTML imprimible media carta)
  // ---------------------------------------------------------------------------
  router.get(
    '/ordenes/institucion/:id/recibo',
    requireAuth,
    async (req, res) => {
      const id = Number(req.params.id);

      try {
        const rows = await dbSelect(
          'SELECT * FROM ordenes_instituciones WHERE id = $1',
          [id]
        );
        if (!rows.length) {
          return res.redirect('/admin/ordenes?tab=instituciones');
        }

        const orden = rows[0];
        const precio = Number(orden.precio || 0);
        const abono = Number(orden.abono || 0);
        const saldo = Math.max(precio - abono, 0);
        const pagoEstado = derivePagoEstado(orden);

        res.render('orden-recibo.ejs', {
          title: 'Recibo — institución',
          tipo: 'institucion',
          idx: id,
          orden,
          precio,
          abono,
          saldo,
          pagoEstado,
        });
      } catch (e) {
        console.error('❌ Error recibo institucion:', e);
        res.redirect('/admin/ordenes?tab=instituciones');
      }
    }
  );

  // ---------------------------------------------------------------------------
  // TICKET 80 mm — PERSONA
  // ---------------------------------------------------------------------------
  router.get('/ordenes/persona/:id/ticket', requireAuth, async (req, res) => {
    const id = Number(req.params.id);

    try {
      const rows = await dbSelect(
        'SELECT * FROM ordenes_personas WHERE id = $1',
        [id]
      );
      if (!rows.length) {
        return res.redirect('/admin/ordenes?tab=personas');
      }

      const orden = rows[0];
      const precio = Number(orden.precio || 0);
      const abono = Number(orden.abono || 0);
      const saldo = Math.max(precio - abono, 0);
      const pagoEstado = derivePagoEstado(orden);

      res.render('orden-ticket.ejs', {
        title: 'Ticket — persona',
        tipo: 'persona',
        idx: id,
        orden,
        precio,
        abono,
        saldo,
        pagoEstado,
      });
    } catch (e) {
      console.error('❌ Error ticket persona:', e);
      res.redirect('/admin/ordenes?tab=personas');
    }
  });

  // ---------------------------------------------------------------------------
  // TICKET 80 mm — INSTITUCIÓN
  // ---------------------------------------------------------------------------
  router.get(
    '/ordenes/institucion/:id/ticket',
    requireAuth,
    async (req, res) => {
      const id = Number(req.params.id);

      try {
        const rows = await dbSelect(
          'SELECT * FROM ordenes_instituciones WHERE id = $1',
          [id]
        );
        if (!rows.length) {
          return res.redirect('/admin/ordenes?tab=instituciones');
        }

        const orden = rows[0];
        const precio = Number(orden.precio || 0);
        const abono = Number(orden.abono || 0);
        const saldo = Math.max(precio - abono, 0);
        const pagoEstado = derivePagoEstado(orden);

        res.render('orden-ticket.ejs', {
          title: 'Ticket — institución',
          tipo: 'institucion',
          idx: id,
          orden,
          precio,
          abono,
          saldo,
          pagoEstado,
        });
      } catch (e) {
        console.error('❌ Error ticket institucion:', e);
        res.redirect('/admin/ordenes?tab=instituciones');
      }
    }
  );

  // ---------------------------------------------------------------------------
  // PANEL DE CITAS
  // ---------------------------------------------------------------------------
  router.get('/citas', requireAuth, (req, res) => {
    const fechaDesde = (req.query.fecha_desde || '').trim();
    const fechaHasta = (req.query.fecha_hasta || '').trim();
    const busqueda = (req.query.q || '').trim().toLowerCase();
    const estadoFil = (req.query.estado || '').trim().toLowerCase();

    const lista = readJson(CITAS_PATH, []);

    // Filtrado
    let citas = (lista || []).filter((c) => {
      // Fecha
      if (fechaDesde || fechaHasta) {
        const f = (c.fecha || '').slice(0, 16); // ISO 2025-11-17T15:30
        if (!f) return false;
        if (fechaDesde && f < fechaDesde) return false;
        if (fechaHasta && f > fechaHasta) return false;
      }

      // Búsqueda por cliente / sesión / teléfono
      if (busqueda) {
        const texto = [c.cliente, c.sesion, c.telefono, c.notas]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        if (!texto.includes(busqueda)) return false;
      }

      // Estado
      if (estadoFil) {
        const e = (c.estado || 'Pendiente').toLowerCase();
        if (e !== estadoFil) return false;
      }

      return true;
    });

    // Ordenar por fecha ascendente
    citas.sort((a, b) => {
      const fa = a.fecha || '';
      const fb = b.fecha || '';
      if (fa < fb) return -1;
      if (fa > fb) return 1;
      return 0;
    });

    res.render('citas.ejs', {
      title: 'Citas',
      citas,
      fechaDesde,
      fechaHasta,
      busqueda,
      estadoFil,
    });
  });

  // Crear nueva cita
  router.post(
    '/citas/nueva',
    requireAuth,
    express.urlencoded({ extended: true }),
    (req, res) => {
      const { cliente, telefono, sesion, fecha, notas } = req.body || {};
      const lista = readJson(CITAS_PATH, []);

      const nuevaCita = {
        id: Date.now(),
        cliente: cliente || '',
        telefono: telefono || '',
        sesion: sesion || '',
        fecha: fecha || '', // formato datetime-local (YYYY-MM-DDTHH:mm)
        notas: notas || '',
        estado: 'Pendiente',
        origen: 'manual', // luego podemos poner google-calendar
      };

      lista.push(nuevaCita);
      writeJson(CITAS_PATH, lista);

      res.redirect('/admin/citas');
    }
  );

  // Cambiar estado de una cita
  router.post(
    '/citas/:idx/estado',
    requireAuth,
    express.urlencoded({ extended: true }),
    (req, res) => {
      const idx = parseInt(req.params.idx, 10);
      const { estado } = req.body || {};

      let lista = readJson(CITAS_PATH, []);

      if (!Array.isArray(lista) || idx < 0 || idx >= lista.length) {
        return res.redirect('/admin/citas');
      }

      const nuevoEstado = ['Pendiente', 'Atendida', 'Cancelada'].includes(
        estado
      )
        ? estado
        : 'Pendiente';

      lista[idx].estado = nuevoEstado;
      writeJson(CITAS_PATH, lista);

      res.redirect('/admin/citas');
    }
  );

  // Eliminar una cita
  router.post(
    '/citas/:idx/eliminar',
    requireAuth,
    express.urlencoded({ extended: true }),
    (req, res) => {
      const idx = parseInt(req.params.idx, 10);
      let lista = readJson(CITAS_PATH, []);

      if (!Array.isArray(lista) || idx < 0 || idx >= lista.length) {
        return res.redirect('/admin/citas');
      }

      // Quitamos la cita del arreglo
      lista.splice(idx, 1);
      writeJson(CITAS_PATH, lista);

      res.redirect('/admin/citas');
    }
  );

  // ---------------------------------------------------------------------------
  // HERRAMIENTAS OCR
  // ---------------------------------------------------------------------------
  router.get('/herramientas', requireAuth, (req, res) => {
    res.render('herramientas-ocr', {
      title: 'Herramientas OCR',
      ocrText: '',
    });
  });

  // Procesar la imagen con OCR (Tesseract + preprocesado con sharp)
  router.post(
    '/herramientas/ocr',
    requireAuth,
    upload.single('imagen_lista'),
    async (req, res) => {
      if (!req.file) {
        return res.render('herramientas-ocr', {
          title: 'Herramientas OCR',
          ocrText: 'Error: no se recibió ninguna imagen.',
        });
      }

      const imagenPath = req.file.path;
      const preprocesadaPath = imagenPath + '-pre.png';
      let textoDelOcr = '';

      try {
        await sharp(imagenPath)
          .resize({ width: 1800, withoutEnlargement: false })
          .grayscale()
          .normalize()
          .toFile(preprocesadaPath);

        const result = await Tesseract.recognize(preprocesadaPath, 'spa+eng', {
          logger: (m) => console.log('[OCR]', m),
        });

        textoDelOcr = (result.data && result.data.text) ? result.data.text : '';

        textoDelOcr = textoDelOcr
          .replace(/\r\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      } catch (err) {
        console.error('❌ Error en OCR:', err);
        textoDelOcr =
          'Ocurrió un error al procesar la imagen con OCR.\n' +
          'Revisa la consola del servidor para más detalles.';
      } finally {
        try { fs.unlinkSync(imagenPath); } catch (e) {}
        try { fs.unlinkSync(preprocesadaPath); } catch (e) {}
      }

      res.render('herramientas-ocr', {
        title: 'Herramientas OCR',
        ocrText: textoDelOcr || '(El OCR no devolvió texto)',
      });
    }
  );

  // ---------------------------------------------------------------------------
  // LOGOUT
  // ---------------------------------------------------------------------------
  router.get('/logout', (req, res) => {
    req.session.destroy(() => {
      res.redirect('/admin/login');
    });
  });

  // Montar router bajo /admin
  app.use('/admin', router);
}

module.exports = mountAdmin;
