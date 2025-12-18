// admin-panel.js
const path = require('path');
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const QRCode = require('qrcode');

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
// Lee los items del body (sirve para nueva-persona y editar-persona)
function parseItemsFromBody(datos) {
  // Soporta nombres con y sin [] (items_cantidad[] o items_cantidad)
  function normArray(baseKey) {
    if (Array.isArray(datos[baseKey + '[]'])) return datos[baseKey + '[]'];
    if (datos[baseKey + '[]'] !== undefined)  return [datos[baseKey + '[]']];
    if (Array.isArray(datos[baseKey]))        return datos[baseKey];
    if (datos[baseKey] !== undefined)         return [datos[baseKey]];
    return [];
  }

  const cantidades    = normArray('items_cantidad');
  const descripciones = normArray('items_descripcion');
  const preciosUnit   = normArray('items_precio_unitario');

  let totalItems = 0;
  const items = [];

  const len = Math.max(cantidades.length, descripciones.length, preciosUnit.length);

  for (let i = 0; i < len; i++) {
    const cant = Number(cantidades[i]) || 0;
    const desc = (descripciones[i] || '').trim();
    const pu   = Number(preciosUnit[i]) || 0;

    if (cant <= 0 || !desc) continue;

    const subtotal = cant * pu;
    totalItems += subtotal;

    items.push({ cant, desc, pu, subtotal });
  }

  return { items, totalItems };
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
function toText(v) {
  if (Array.isArray(v)) {
    const first = v.find(x => String(x || '').trim() !== '');
    return (first || '').toString().trim();
  }
  return (v || '').toString().trim();
}

function paginate(list, page, pageSize) {
  const totalItems = Array.isArray(list) ? list.length : 0;
  const totalPages = Math.max(Math.ceil(totalItems / pageSize), 1);
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * pageSize;

  return {
    items: (list || []).slice(start, start + pageSize),
    totalItems,
    totalPages,
    currentPage: safePage,
  };
}

// =======================
// PAGINACIÓN PRO (helpers)
// =======================

// Pagina un array y regresa meta
function paginateArray(list, page, pageSize) {
  const totalItems = Array.isArray(list) ? list.length : 0;
  const totalPages = Math.max(Math.ceil(totalItems / pageSize), 1);
  const currentPage = Math.min(Math.max(Number(page) || 1, 1), totalPages);
  const start = (currentPage - 1) * pageSize;

  return {
    items: (list || []).slice(start, start + pageSize),
    totalItems,
    totalPages,
    currentPage,
    pageSize,
  };
}

// Construye los botones de paginación tipo "pro" (1 2 3 ... 10)
// Mantiene filtros en los links usando req.query
function buildPagerPro({ currentPage, totalPages, reqQuery, windowSize = 7 }) {
  const pages = [];

  if (totalPages <= 1) {
    return { pages, hasPrev: false, hasNext: false, prevPage: 1, nextPage: 1 };
  }

  const half = Math.floor(windowSize / 2);

  let start = Math.max(1, currentPage - half);
  let end = Math.min(totalPages, start + windowSize - 1);

  // Ajuste si quedamos cortos al final
  start = Math.max(1, end - windowSize + 1);

  // helper: arma URL con mismos filtros
  function makeUrl(p) {
    const q = { ...reqQuery, page: String(p) };
    // importante: si tab no viene, lo ponemos en personas cuando estamos en esa sección
    if (!q.tab) q.tab = 'personas';
    return '/admin/ordenes?' + new URLSearchParams(q).toString();
  }

  // Siempre mostramos el 1
  pages.push({ label: '1', page: 1, url: makeUrl(1), isCurrent: currentPage === 1 });

  // Ellipsis si hay hueco
  if (start > 2) pages.push({ label: '…', isEllipsis: true });

  // Ventana central
  for (let p = Math.max(2, start); p <= Math.min(end, totalPages - 1); p++) {
    pages.push({
      label: String(p),
      page: p,
      url: makeUrl(p),
      isCurrent: p === currentPage,
    });
  }

  // Ellipsis final
  if (end < totalPages - 1) pages.push({ label: '…', isEllipsis: true });

  // Siempre mostramos el último si totalPages > 1
  if (totalPages > 1) {
    pages.push({
      label: String(totalPages),
      page: totalPages,
      url: makeUrl(totalPages),
      isCurrent: currentPage === totalPages,
    });
  }

  return {
    pages,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
    prevPage: Math.max(currentPage - 1, 1),
    nextPage: Math.min(currentPage + 1, totalPages),
    prevUrl: makeUrl(Math.max(currentPage - 1, 1)),
    nextUrl: makeUrl(Math.min(currentPage + 1, totalPages)),
  };
}

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
    {
  href: '/admin/evento/telefonos',
  icon: '📱',
  title: 'Teléfonos evento',
  desc: 'Ver, filtrar y administrar teléfonos de los participantes.',
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

         // 🔹 Citas desde PostgreSQL
      let listaCitas = [];
      try {
        listaCitas = await dbSelect(
          'SELECT * FROM citas ORDER BY fecha ASC NULLS LAST'
        );
      } catch (e) {
        console.error('❌ Error cargando citas desde PostgreSQL:', e);
        listaCitas = [];
      }

      const hoyStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

      const citasHoy = listaCitas.filter((c) => {
        // c.fecha viene como Date (TIMESTAMPTZ)
        if (!c.fecha) return false;
        const d = new Date(c.fecha);
        if (isNaN(d.getTime())) return false;
        const soloFecha = d.toISOString().slice(0, 10);
        return soloFecha === hoyStr;
      });

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
      // ================== PRÓXIMAS ENTREGAS & ATRASADAS ==================
    const hoy = new Date();
    const hoyISO = hoy.toISOString().slice(0, 10); // YYYY-MM-DD

    const limite = new Date(hoy);
    limite.setDate(limite.getDate() + 3);
    const limiteISO = limite.toISOString().slice(0, 10);

    // Personas pendientes
   // Personas pendientes
const pendientesPersonas = await dbSelect(`
  SELECT id, nombre, precio, abono, fecha_entrega, urgencia, entrega,
         editado, editado_at,
         impresos, impreso_at
  FROM ordenes_personas
  WHERE fecha_entrega IS NOT NULL
    AND (entrega IS NULL OR entrega <> 'Entregado')
`);

// Instituciones pendientes
const pendientesInst = await dbSelect(`
  SELECT id, institucion, precio, abono, fecha_entrega, urgencia, entrega,
         editado, editado_at,
         impresos, impreso_at
  FROM ordenes_instituciones
  WHERE fecha_entrega IS NOT NULL
    AND (entrega IS NULL OR entrega <> 'Entregado')
`);


    // Unir todo en un solo arreglo con un campo _tipo
    const todasPendientes = [
      ...pendientesPersonas.map(o => ({ ...o, _tipo: 'persona' })),
      ...pendientesInst.map(o => ({ ...o, _tipo: 'institucion' })),
    ];

    function soloFecha(value) {
      if (!value) return null;
      const d = new Date(value);
      if (isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10); // YYYY-MM-DD
    }

    const proximasEntregas = [];
    const entregasAtrasadas = [];

    for (const o of todasPendientes) {
      const f = soloFecha(o.fecha_entrega);
      if (!f) continue;

      if (f < hoyISO) {
        // Ya se venció
        entregasAtrasadas.push({ ...o, _fecha: f });
      } else if (f >= hoyISO && f <= limiteISO) {
        // Próximos 3 días
        proximasEntregas.push({ ...o, _fecha: f });
      }
    }

    // Ordenar por fecha
    proximasEntregas.sort((a, b) => a._fecha.localeCompare(b._fecha));
    entregasAtrasadas.sort((a, b) => a._fecha.localeCompare(b._fecha));

     // 🔹 Resumen del evento (participantes / teléfonos)
      let resumenEvento = {
        total_participantes: 0,
        con_telefono: 0,
        sin_telefono: 0,
        facultades: 0,
        carreras: 0,
        grupos: 0,
      };

      try {
        const rowsEvento = await dbSelect(`
          SELECT
            COUNT(*) AS total_participantes,
            COUNT(*) FILTER (WHERE telefono IS NOT NULL AND telefono <> '') AS con_telefono,
            COUNT(*) FILTER (WHERE telefono IS NULL OR telefono = '') AS sin_telefono,
            COUNT(DISTINCT facultad) AS facultades,
            COUNT(DISTINCT carrera) AS carreras,
            COUNT(DISTINCT grupo_horario) AS grupos
          FROM evento_participantes
        `);

        if (rowsEvento.length) {
          resumenEvento = rowsEvento[0];
        }
      } catch (e) {
        console.error('❌ Error cargando resumenEvento:', e);
      }

      // =======================
// RESUMEN EDITOR (panel principal)
// =======================
const [{ c: editadasPersonas }] = await dbSelect(
  `SELECT COUNT(*)::int AS c FROM ordenes_personas WHERE editado = true`
);

const [{ c: editadasInst }] = await dbSelect(
  `SELECT COUNT(*)::int AS c FROM ordenes_instituciones WHERE editado = true`
);

const [{ c: impresasPersonas }] = await dbSelect(
  `SELECT COUNT(*)::int AS c FROM ordenes_personas WHERE impresos = true`
);

const [{ c: impresasInst }] = await dbSelect(
  `SELECT COUNT(*)::int AS c FROM ordenes_instituciones WHERE impresos = true`
);

const resumenEditor = {
  editadas: (editadasPersonas || 0) + (editadasInst || 0),
  impresas: (impresasPersonas || 0) + (impresasInst || 0),
  editadasPersonas: editadasPersonas || 0,
  editadasInst: editadasInst || 0,
  impresasPersonas: impresasPersonas || 0,
  impresasInst: impresasInst || 0,
};

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
        entregasAtrasadas,
        resumenEvento,
        resumenEditor,

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
        entregasAtrasadas: [],
         resumenEvento: {
          total_participantes: 0,
          con_telefono: 0,
          sin_telefono: 0,
          facultades: 0,
          carreras: 0,
          grupos: 0,
        },
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

    // ✅ paginación (solo personas por ahora)
const page = Math.max(parseInt(req.query.page || '1', 10), 1);
const pageSize = 20; // puedes cambiar a 30 si quieres


    // Filtros recibidos del formulario
    const fechaDesde = (req.query.fecha_desde || '').trim();
    const fechaHasta = (req.query.fecha_hasta || '').trim();
    const fechaEntregaDesde = (req.query.fecha_entrega_desde || '').trim();
    const fechaEntregaHasta = (req.query.fecha_entrega_hasta || '').trim();

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
  // 🔹 Fecha de entrega
if (fechaEntregaDesde || fechaEntregaHasta) {
  const fEnt = normalizarFechaFiltro(o.fecha_entrega);
  if (!fEnt) return false;

  if (fechaEntregaDesde && fEnt < fechaEntregaDesde) return false;
  if (fechaEntregaHasta && fEnt > fechaEntregaHasta) return false;
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

   // ================= PAGINACIÓN PRO (solo personas) =================
let pagPersonas = null;
let pagerPersonas = null;

if (tab === 'personas') {
  pagPersonas = paginateArray(ordenesPersonas, page, pageSize);

  pagerPersonas = buildPagerPro({
    currentPage: pagPersonas.currentPage,
    totalPages: pagPersonas.totalPages,
    reqQuery: req.query,   // <-- CLAVE: mantiene filtros en links
    windowSize: 7,
  });
} else {
  // si no estás en personas, igual evitamos undefined
  pagPersonas = paginateArray(ordenesPersonas, 1, pageSize);
}



    // Resúmenes de pago
    const resumenInstituciones = calcularResumen(ordenesInstituciones);
    const resumenPersonas = calcularResumen(ordenesPersonas);

  res.render('ordenes', {
  title: 'Órdenes y libros',
  tab,
  ordenesInstituciones,
  ordenesPersonas: (tab === 'personas') ? pagPersonas.items : ordenesPersonas,

  fechaDesde,
  fechaHasta,
  fechaEntregaDesde,
  fechaEntregaHasta,
  busqueda,
  filtroUrg,
  filtroEnt,
  filtroPago,

  resumenInstituciones,
  resumenPersonas,

  // paginación
  page: (tab === 'personas') ? pagPersonas.currentPage : 1,
  totalPages: (tab === 'personas') ? pagPersonas.totalPages : 1,
  pageSize,

  pagerPersonas,  // <-- NUEVO (PRO)
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
      numero_toma,
      fecha_toma,
      fecha_entrega,
      urgencia,
      precio,
      telefono,
      estado_entrega,
      pago_estado,
      // 👇 OJO: NO confíes directo en evento/atendido_por aquí
    } = datos;

    // ✅ Blindaje: si viene array, tomamos solo el primer valor
    const eventoTxt = toText(datos.evento);
    const atendidoTxt = toText(datos.atendido_por);

    // 1) Ítems del body
    const { items, totalItems } = parseItemsFromBody(datos);

    // 2) Precio / abono / estado de pago
    let precioNum = Number(precio) || 0;
    let abonoNum = getAbonoFromBody(datos);
    let pagoEstado = pago_estado || 'Pendiente';

    if (precioNum <= 0 && totalItems > 0) {
      precioNum = totalItems;
    }

    if (pagoEstado === 'Pagado' && precioNum > 0) {
      abonoNum = precioNum;
    } else {
      pagoEstado = computePagoEstado(precioNum, abonoNum);
    }

    try {
      const insertCabecera = `
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
          pago_estado,
          evento,
          atendido_por
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING id
      `;

      const { rows } = await db.query(insertCabecera, [
        nombre || '',
        '',
        numero_toma || '',
        fecha_toma || null,
        fecha_entrega || null,
        urgencia || 'Normal',
        precioNum,
        telefono || '',
        estado_entrega || 'Pendiente',
        abonoNum,
        pagoEstado,
        eventoTxt,       // ✅ aquí
        atendidoTxt,     // ✅ aquí
      ]);

      const nuevaId = rows[0]?.id;

      if (nuevaId && items.length) {
        for (const it of items) {
          await dbExec(
            `
            INSERT INTO ordenes_personas_detalle
              (orden_persona_id, cantidad, descripcion, precio_unitario, subtotal)
            VALUES ($1,$2,$3,$4,$5)
            `,
            [nuevaId, it.cant, it.desc, it.pu, it.subtotal]
          );
        }
      }

      console.log('💾 Nueva orden persona + detalle guardados en PostgreSQL');
    } catch (err) {
      console.error('❌ Error guardando orden PERSONA (cabecera/detalle):', err);
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
  `UPDATE ordenes_personas 
   SET nombre=$1,
       numero_toma=$2,
       fecha_toma=$3,
       fecha_entrega=$4,
       urgencia=$5,
       precio=$6,
       abono=$7,
       telefono=$8,
       entrega=$9,
       evento=$10,
       atendido_por=$11,
       updated_at = NOW()
   WHERE id = $12`,
  [
    req.body.nombre || '',
    req.body.numero_toma || '',
    req.body.fecha_toma || null,
    req.body.fecha_entrega || null,
    req.body.urgencia || 'Normal',
    Number(req.body.precio) || 0,
    Number(req.body.abono) || 0,
    req.body.telefono || '',
    req.body.estado_entrega || 'Pendiente',
    req.body.evento || '',
    req.body.atendido_por || '',
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
// ---------------------------------------------------------------------------
// EDITAR ORDEN — PERSONA (GET)
// ---------------------------------------------------------------------------
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

    // Detalle de ítems (solo lectura en esta vista)
    const detalles = await dbSelect(
      `
      SELECT id, cantidad, descripcion, precio_unitario, subtotal
      FROM ordenes_personas_detalle
      WHERE orden_persona_id = $1
      ORDER BY id ASC
      `,
      [id]
    );

    const precio = Number(orden.precio || 0);
    const abono  = Number(orden.abono || 0);
    const saldo  = Math.max(precio - abono, 0);
    const pagoEstado = derivePagoEstado(orden);

    let totalDetalle = 0;
    for (const d of detalles) {
      const sub = d.subtotal != null
        ? Number(d.subtotal)
        : (Number(d.cantidad || 0) * Number(d.precio_unitario || 0));
      if (!isNaN(sub)) totalDetalle += sub;
    }

    res.render('ordenes-editar-persona', {
      title: 'Editar orden — persona',
      idx: id,
      orden,
      detalles,
      totalDetalle,
      precio,
      abono,
      saldo,
      pagoEstado,
    });
  } catch (err) {
    console.error('❌ Error GET editar persona:', err);
    res.status(500).send('Error interno');
  }
});


  // POST - Guardar edición persona
// ---------------------------------------------------------------------------
// EDITAR ORDEN — PERSONA (cabecera + detalle)
// ---------------------------------------------------------------------------
router.post(
  '/ordenes/persona/:id/editar',
  requireAuth,
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const datos = req.body || {};

      if (!id || id <= 0) {
        return res.redirect('/admin/ordenes?tab=personas');
      }

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
        // 👇 NO confiamos directo en evento/atendido_por
      } = datos;

      // ✅ Blindaje
      const eventoTxt = toText(datos.evento);
      const atendidoTxt = toText(datos.atendido_por);

      // 1) Leer ítems del form
      const { items, totalItems } = parseItemsFromBody(datos);

      // 2) Precio / abono / estado de pago
      let precioNum = Number(precio) || 0;
      const abonoNum = Number(abono) || 0;

      if (precioNum <= 0 && totalItems > 0) {
        precioNum = totalItems;
      }

      const pagoEstado = computePagoEstado(precioNum, abonoNum);

      // 3) Actualizar cabecera
      await dbExec(
        `UPDATE ordenes_personas 
         SET nombre       = $1,
             numero_orden = $2,
             numero_toma  = $3,
             fecha_toma   = $4,
             fecha_entrega= $5,
             urgencia     = $6,
             precio       = $7,
             abono        = $8,
             telefono     = $9,
             entrega      = $10,
             evento       = $11,
             atendido_por = $12,
             pago_estado  = $13
         WHERE id = $14`,
        [
          nombre || '',
          numero_orden || '',
          numero_toma || '',
          fecha_toma || null,
          fecha_entrega || null,
          urgencia || 'Normal',
          precioNum,
          abonoNum,
          telefono || '',
          estado_entrega || 'Pendiente',
          eventoTxt,       // ✅ aquí
          atendidoTxt,     // ✅ aquí
          pagoEstado,
          id,
        ]
      );

      // 4) Reemplazar detalle
      await dbExec(
        'DELETE FROM ordenes_personas_detalle WHERE orden_persona_id = $1',
        [id]
      );

      if (items.length) {
        for (const it of items) {
          await dbExec(
            `
            INSERT INTO ordenes_personas_detalle
              (orden_persona_id, cantidad, descripcion, precio_unitario, subtotal)
            VALUES ($1,$2,$3,$4,$5)
            `,
            [id, it.cant, it.desc, it.pu, it.subtotal]
          );
        }
      }

      console.log('💾 Orden persona actualizada (cabecera + detalle)');
      res.redirect('/admin/ordenes?tab=personas');
    } catch (err) {
      console.error('❌ Error POST editar persona (cabecera/detalle):', err);
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
      // Orden principal
      const rows = await dbSelect(
        'SELECT * FROM ordenes_personas WHERE id = $1',
        [id]
      );
      if (!rows.length) {
        return res.redirect('/admin/ordenes?tab=personas');
      }
      const orden = rows[0];

      // Detalle de productos/servicios
      const detalles = await dbSelect(
        `
        SELECT id, cantidad, descripcion, precio_unitario, subtotal
        FROM ordenes_personas_detalle
        WHERE orden_persona_id = $1
        ORDER BY id ASC
        `,
        [id]
      );

      // Cálculos de pago
      const precio = Number(orden.precio || 0);
      const abono  = Number(orden.abono || 0);
      const saldo  = Math.max(precio - abono, 0);
      const pagoEstado = derivePagoEstado(orden);

      // Total del detalle (por si quieres mostrarlo)
      let totalDetalle = 0;
      for (const d of detalles) {
        const sub = d.subtotal != null
          ? Number(d.subtotal)
          : (Number(d.cantidad || 0) * Number(d.precio_unitario || 0));
        if (!isNaN(sub)) totalDetalle += sub;
      }

      res.render('orden-detalle', {
        title: 'Detalle de orden — persona',
        tipo: 'persona',
        idx: id,
        orden,
        // nuevos:
        detalles,
        totalDetalle,
        precio,
        abono,
        saldo,
        pagoEstado,
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
      const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const entregarUrl = `${baseUrl}/admin/entregar/persona/${id}`;

// Generar QR como DataURL (imagen en base64)
const qrDataUrl = await QRCode.toDataURL(entregarUrl, {
  margin: 1,
  width: 180,
});

      // 👇 NUEVO: leer desglose de productos/servicios
      const detalles = await dbSelect(
        `
        SELECT descripcion, cantidad, precio_unitario, subtotal
        FROM ordenes_personas_detalle
        WHERE orden_persona_id = $1
        ORDER BY id ASC
        `,
        [id]
      );

      res.render('orden-ticket.ejs', {
        title: 'Ticket — persona',
        tipo: 'persona',
        idx: id,
        orden,
        precio,
        abono,
        saldo,
        pagoEstado,
        detalles,   // 👈 ahora sí llega al EJS con data real
        qrDataUrl,
        entregarUrl,
      });
    } catch (e) {
      console.error('❌ Error ticket persona:', e);
      res.redirect('/admin/ordenes?tab=personas');
    }
  });

// ---------------------------------------------------------------------------
// MARCAR ENTREGADO (QR) — PERSONA
// ---------------------------------------------------------------------------
router.get('/entregar/persona/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!id || id <= 0) return res.status(400).send('ID inválido');

  try {
    // OJO: no dependamos de updated_at por si algo raro
    const r = await dbExec(
      `UPDATE ordenes_personas
       SET entrega = 'Entregado'
       WHERE id = $1`,
      [id]
    );

    return res.redirect(`/admin/ordenes/persona/${id}`);
  } catch (err) {
    console.error('❌ Error marcando entregado (persona):', err);
    return res.status(500).send(`Error interno: ${err.message || err}`);
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
  // PANEL DE CITAS (PostgreSQL)
  // ---------------------------------------------------------------------------
  router.get('/citas', requireAuth, async (req, res) => {
    const fechaDesde = (req.query.fecha_desde || '').trim(); // datetime-local
    const fechaHasta = (req.query.fecha_hasta || '').trim();
    const busqueda = (req.query.q || '').trim().toLowerCase();
    const estadoFil = (req.query.estado || '').trim().toLowerCase();

    try {
      // 1) Leer TODAS las citas desde PostgreSQL
      const rows = await dbSelect(
        'SELECT * FROM citas ORDER BY fecha ASC NULLS LAST'
      );

      // 2) Normalizar fecha a string "YYYY-MM-DDTHH:mm" para que el EJS funcione igual
      let citas = (rows || []).map((c) => {
        let fechaTexto = '';
        if (c.fecha) {
          const d = new Date(c.fecha);
          if (!isNaN(d.getTime())) {
            fechaTexto = d.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:mm"
          }
        }

        return {
          ...c,
          fecha: fechaTexto, // ← lo que usa la vista
        };
      });

      // 3) Aplicar los mismos filtros que antes, pero sobre el array que viene de la BD
      citas = citas.filter((c) => {
        // ---- Filtro por fecha/hora ----
        if (fechaDesde || fechaHasta) {
          const f = (c.fecha || '').slice(0, 16);
          if (!f) return false;
          if (fechaDesde && f < fechaDesde) return false;
          if (fechaHasta && f > fechaHasta) return false;
        }

        // ---- Búsqueda por cliente / sesión / teléfono / notas ----
        if (busqueda) {
          const texto = [c.cliente, c.sesion, c.telefono, c.notas]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

          if (!texto.includes(busqueda)) return false;
        }

        // ---- Filtro por estado ----
        if (estadoFil) {
          const e = (c.estado || 'Pendiente').toLowerCase();
          if (e !== estadoFil) return false;
        }

        return true;
      });

      // 4) Ordenar por fecha ascendente (por si acaso)
      citas.sort((a, b) => {
        const fa = a.fecha || '';
        const fb = b.fecha || '';
        if (fa < fb) return -1;
        if (fa > fb) return 1;
        return 0;
      });

      // 5) Renderizar igual que antes
      res.render('citas.ejs', {
        title: 'Citas',
        citas,
        fechaDesde,
        fechaHasta,
        busqueda,
        estadoFil,
      });
    } catch (err) {
      console.error('❌ Error en /admin/citas (PostgreSQL):', err);

      // Fallback simple por si falla la BD
      res.render('citas.ejs', {
        title: 'Citas',
        citas: [],
        fechaDesde,
        fechaHasta,
        busqueda,
        estadoFil,
      });
    }
  });

    // Crear nueva cita (PostgreSQL)
  router.post(
    '/citas/nueva',
    requireAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const { cliente, telefono, sesion, fecha, notas } = req.body || {};

      try {
        await dbExec(
          `
          INSERT INTO citas (cliente, telefono, sesion, fecha, notas, estado, origen)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
          [
            cliente || '',
            telefono || '',
            sesion || '',
            fecha || null,      // PostgreSQL lo convierte a TIMESTAMPTZ
            notas || '',
            'Pendiente',
            'manual',
          ]
        );

        console.log('💾 Nueva cita guardada en PostgreSQL');
      } catch (err) {
        console.error('❌ Error guardando cita en PostgreSQL:', err);
      }

      res.redirect('/admin/citas');
    }
  );

  // Cambiar estado de una cita (PostgreSQL)
  router.post(
    '/citas/:id/estado',
    requireAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const id = Number(req.params.id);
      const { estado } = req.body || {};

      if (!id || id <= 0) {
        return res.redirect('/admin/citas');
      }

      const nuevoEstado = ['Pendiente', 'Atendida', 'Cancelada'].includes(
        estado
      )
        ? estado
        : 'Pendiente';

      try {
        await dbExec(
          `
          UPDATE citas
          SET estado = $1, updated_at = NOW()
          WHERE id = $2
        `,
          [nuevoEstado, id]
        );
      } catch (err) {
        console.error('❌ Error cambiando estado de cita en PostgreSQL:', err);
      }

      res.redirect('/admin/citas');
    }
  );

   // Eliminar una cita (PostgreSQL)
  router.post(
    '/citas/:id/eliminar',
    requireAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const id = Number(req.params.id);

      if (!id || id <= 0) {
        return res.redirect('/admin/citas');
      }

      try {
        await dbExec('DELETE FROM citas WHERE id = $1', [id]);
      } catch (err) {
        console.error('❌ Error eliminando cita en PostgreSQL:', err);
      }

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
  // GUARDAR LISTA DE NOMBRES EN POSTGRESQL (evento_participantes)
  // ---------------------------------------------------------------------------
  router.post(
    '/herramientas/lista-guardar',
    requireAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const { facultad, carrera, grupo_horario, lista_nombres } = req.body || {};

      const fac = (facultad || '').trim();
      const car = (carrera || '').trim();
      const grupo = (grupo_horario || '').trim();
      const texto = (lista_nombres || '').trim();

      if (!fac || !car || !grupo || !texto) {
        console.error('❌ Datos incompletos al guardar lista de participantes');
        return res.redirect('/admin/herramientas');
      }

      const lineas = texto.split(/\r?\n/);
      let numero = 0;

      try {
        for (let linea of lineas) {
          const nombre = (linea || '').trim();
          if (!nombre) continue;

          numero += 1;

          await dbExec(
            `
            INSERT INTO evento_participantes
              (facultad, carrera, grupo_horario, numero_lista, nombre)
            VALUES ($1, $2, $3, $4, $5)
          `,
            [fac, car, grupo, numero, nombre]
          );
        }

        console.log(
          `💾 Lista guardada en evento_participantes: ${fac} / ${car} / ${grupo} -> ${numero} registros`
        );
      } catch (err) {
        console.error('❌ Error guardando lista en evento_participantes:', err);
      }

      res.redirect('/admin/herramientas');
    }
  );
  // ---------------------------------------------------------------------------
  // PANEL PARA TELÉFONOS DE EVENTO (evento_participantes)
  // ---------------------------------------------------------------------------
    router.get('/evento/telefonos', requireAuth, async (req, res) => {
    const facultad = (req.query.facultad || '').trim();
    const carrera = (req.query.carrera || '').trim();
    const grupo = (req.query.grupo_horario || '').trim();
    const nombre = (req.query.nombre || '').trim();

    let participantes = [];

    try {
      let where = [];
      let params = [];

      if (facultad) {
        params.push(`%${facultad}%`);
        where.push(`facultad ILIKE $${params.length}`);
      }

      if (carrera) {
        params.push(`%${carrera}%`);
        where.push(`carrera ILIKE $${params.length}`);
      }

      if (grupo) {
        params.push(`%${grupo}%`);
        where.push(`grupo_horario ILIKE $${params.length}`);
      }

      if (nombre) {
        params.push(`%${nombre}%`);
        where.push(`nombre ILIKE $${params.length}`);
      }

      let sql = `
        SELECT id, facultad, carrera, grupo_horario,
               numero_lista, nombre, telefono
        FROM evento_participantes
      `;

      if (where.length > 0) {
        sql += ' WHERE ' + where.join(' AND ');
      }

      sql += `
        ORDER BY facultad, carrera, grupo_horario, numero_lista ASC
      `;

      participantes = await dbSelect(sql, params);
    } catch (err) {
      console.error('❌ Error cargando evento_participantes:', err);
      participantes = [];
    }

    res.render('evento-telefonos', {
      title: 'Teléfonos de participantes',
      facultad,
      carrera,
      grupo_horario: grupo,
      nombre,
      participantes,
    });
  });
  // ---------------------------------------------------------------------------
  // EXPORTAR PARTICIPANTES A EXCEL (CSV)
  // ---------------------------------------------------------------------------
  router.get('/evento/telefonos/export', requireAuth, async (req, res) => {
    const facultad = (req.query.facultad || '').trim();
    const carrera = (req.query.carrera || '').trim();
    const grupo = (req.query.grupo_horario || '').trim();
    const nombre = (req.query.nombre || '').trim();

    try {
      let where = [];
      let params = [];

      if (facultad) {
        params.push(`%${facultad}%`);
        where.push(`facultad ILIKE $${params.length}`);
      }

      if (carrera) {
        params.push(`%${carrera}%`);
        where.push(`carrera ILIKE $${params.length}`);
      }

      if (grupo) {
        params.push(`%${grupo}%`);
        where.push(`grupo_horario ILIKE $${params.length}`);
      }

      if (nombre) {
        params.push(`%${nombre}%`);
        where.push(`nombre ILIKE $${params.length}`);
      }

      let sql = `
        SELECT facultad, carrera, grupo_horario,
               numero_lista, nombre, telefono
        FROM evento_participantes
      `;

      if (where.length > 0) {
        sql += ' WHERE ' + where.join(' AND ');
      }

      sql += `
        ORDER BY facultad, carrera, grupo_horario, numero_lista ASC
      `;

      const rows = await dbSelect(sql, params);

      // Construir CSV
      let csv = 'Facultad,Carrera,Grupo,NumeroLista,Nombre,Telefono\n';

      for (const r of rows) {
        // Limpiar comas y saltos de línea
        const fac = (r.facultad || '').replace(/"/g, '""');
        const car = (r.carrera || '').replace(/"/g, '""');
        const grp = (r.grupo_horario || '').replace(/"/g, '""');
        const num = r.numero_lista || '';
        const nom = (r.nombre || '').replace(/"/g, '""');
        const tel = (r.telefono || '').replace(/"/g, '""');

        csv += `"${fac}","${car}","${grp}",${num},"${nom}","${tel}"\n`;
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="evento_participantes.csv"'
      );
      res.send(csv);
    } catch (err) {
      console.error('❌ Error exportando CSV de evento_participantes:', err);
      res.status(500).send('Error al exportar CSV');
    }
  });


  // Guardar / actualizar teléfono de un participante
  // Guardar / actualizar teléfono de un participante o eliminarlo
router.post(
  '/evento/telefono/:id',
  requireAuth,
  express.urlencoded({ extended: true }),
  async (req, res) => {
    const id = Number(req.params.id);
    const telefono = (req.body.telefono || '').trim();
    const accion = (req.body.accion || 'guardar').toLowerCase();

    if (!id || id <= 0) {
      return res.redirect('/admin/evento/telefonos');
    }

    try {
      if (accion === 'eliminar') {
        await dbExec(
          'DELETE FROM evento_participantes WHERE id = $1',
          [id]
        );
        console.log(`🗑 Participante ${id} eliminado de evento_participantes`);
      } else {
        await dbExec(
          `
          UPDATE evento_participantes
          SET telefono = $1, updated_at = NOW()
          WHERE id = $2
        `,
          [telefono, id]
        );
      }
    } catch (err) {
      console.error('❌ Error en /evento/telefono/:id (guardar/eliminar):', err);
    }

    // Siempre regresamos a la pantalla de teléfonos
    res.redirect('/admin/evento/telefonos');
  }
);


    // ---------------------------------------------------------------------------
  // ELIMINAR PARTICIPANTES FILTRADOS (por facultad/carrera/grupo/nombre)
  // ---------------------------------------------------------------------------
  router.post(
    '/evento/telefonos/eliminar-grupo',
    requireAuth,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const facultad = (req.body.facultad || '').trim();
      const carrera = (req.body.carrera || '').trim();
      const grupo = (req.body.grupo_horario || '').trim();
      const nombre = (req.body.nombre || '').trim();

      try {
        let where = [];
        let params = [];

        if (facultad) {
          params.push(`%${facultad}%`);
          where.push(`facultad ILIKE $${params.length}`);
        }

        if (carrera) {
          params.push(`%${carrera}%`);
          where.push(`carrera ILIKE $${params.length}`);
        }

        if (grupo) {
          params.push(`%${grupo}%`);
          where.push(`grupo_horario ILIKE $${params.length}`);
        }

        if (nombre) {
          params.push(`%${nombre}%`);
          where.push(`nombre ILIKE $${params.length}`);
        }

        if (where.length === 0) {
          console.warn('⚠️ Intento de eliminar grupo sin filtros, cancelado.');
          return res.redirect('/admin/evento/telefonos');
        }

        let sql = 'DELETE FROM evento_participantes';

        if (where.length > 0) {
          sql += ' WHERE ' + where.join(' AND ');
        }

        await dbExec(sql, params);
        console.log('🗑 Participantes eliminados con filtros:', {
          facultad,
          carrera,
          grupo,
          nombre,
        });
      } catch (err) {
        console.error('❌ Error eliminando grupo en evento_participantes:', err);
      }

      // Redirigir manteniendo los filtros (para que veas que ya no hay nada)
      const query = new URLSearchParams({
        facultad,
        carrera,
        grupo_horario: grupo,
        nombre,
      }).toString();

      res.redirect('/admin/evento/telefonos?' + query);
    }
  );


// ---------------------------------------------------------------------------
// PANEL DEL EDITOR (solo entregas de hoy + urgentes)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PANEL DEL EDITOR (rango entrega + urgentes)
// ---------------------------------------------------------------------------
router.get('/editor', requireAuth, async (req, res) => {
  // ================= FILTROS EDITOR =================
  const diasDespues = 8;

  const hoy = new Date();
  const yyyy = hoy.getFullYear();
  const mm = String(hoy.getMonth() + 1).padStart(2, '0');
  const dd = String(hoy.getDate()).padStart(2, '0');
  const hoyStr = `${yyyy}-${mm}-${dd}`; // YYYY-MM-DD

  const entregaDesde = (req.query.entrega_desde || '').trim(); // YYYY-MM-DD
  const entregaHasta = (req.query.entrega_hasta || '').trim(); // YYYY-MM-DD

  function addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${da}`;
  }

  // si no mandan filtros: hoy -> hoy+8
  const desdeFinal = entregaDesde || hoyStr;
  const hastaFinal = entregaHasta || addDays(hoyStr, diasDespues);

  // para mantener el returnTo en POST
  const currentUrl = req.originalUrl.startsWith('/admin')
    ? req.originalUrl
    : `/admin${req.originalUrl}`;

  try {
    // 🔹 ENTREGAS EN RANGO (personas)
    const entregasRangoPersonas = await dbSelect(
      `
      SELECT id, nombre, numero_orden, numero_toma,
             fecha_toma, fecha_entrega, urgencia, entrega,
             impresos, impreso_at,
             editado, editado_at,
             evento, atendido_por
      FROM ordenes_personas
      WHERE fecha_entrega::date >= $1
        AND fecha_entrega::date <= $2
        AND (entrega IS NULL OR entrega <> 'Entregado')
      ORDER BY fecha_entrega ASC NULLS LAST, urgencia DESC, id ASC
      `,
      [desdeFinal, hastaFinal]
    );

    // 🔹 ENTREGAS EN RANGO (instituciones)
    const entregasRangoInst = await dbSelect(
      `
      SELECT id, institucion, nombre, seccion, paquete,
             fecha_toma, fecha_entrega, urgencia, entrega,
             impresos, impreso_at,
             editado, editado_at
      FROM ordenes_instituciones
      WHERE fecha_entrega::date >= $1
        AND fecha_entrega::date <= $2
        AND (entrega IS NULL OR entrega <> 'Entregado')
      ORDER BY fecha_entrega ASC NULLS LAST, urgencia DESC, id ASC
      `,
      [desdeFinal, hastaFinal]
    );

    const entregasRango = [
      ...entregasRangoPersonas.map(o => ({ ...o, _tipo: 'persona' })),
      ...entregasRangoInst.map(o => ({ ...o, _tipo: 'institucion' })),
    ];

    // 🔹 URGENTES (pendientes) — opcional: los mostramos aunque no caigan en el rango
    const urgentesPersonas = await dbSelect(
      `
      SELECT id, nombre, numero_orden, numero_toma,
             fecha_toma, fecha_entrega, urgencia, entrega,
             impresos, impreso_at,
             editado, editado_at,
             evento, atendido_por
      FROM ordenes_personas
      WHERE (urgencia = 'Urgente' OR urgencia = 'Muy urgente')
        AND (entrega IS NULL OR entrega <> 'Entregado')
      ORDER BY fecha_entrega ASC NULLS LAST, id ASC
      `
    );

    const urgentesInst = await dbSelect(
      `
      SELECT id, institucion, nombre, seccion, paquete,
             fecha_toma, fecha_entrega, urgencia, entrega,
             impresos, impreso_at,
             editado, editado_at
      FROM ordenes_instituciones
      WHERE (urgencia = 'Urgente' OR urgencia = 'Muy urgente')
        AND (entrega IS NULL OR entrega <> 'Entregado')
      ORDER BY fecha_entrega ASC NULLS LAST, id ASC
      `
    );

    const urgentes = [
      ...urgentesPersonas.map(o => ({ ...o, _tipo: 'persona' })),
      ...urgentesInst.map(o => ({ ...o, _tipo: 'institucion' })),
    ];

    res.render('editor', {
      title: 'Panel del editor',
      diasDespues,
      entregaDesde: desdeFinal,
      entregaHasta: hastaFinal,
      currentUrl,
      entregasRango,
      urgentes,
    });
  } catch (err) {
    console.error('❌ Error en /admin/editor:', err);
    res.render('editor', {
      title: 'Panel del editor',
      diasDespues,
      entregaDesde: desdeFinal,
      entregaHasta: hastaFinal,
      currentUrl,
      entregasRango: [],
      urgentes: [],
    });
  }
});
function safeReturnTo(v) {
  if (!v) return '/admin/editor';
  // seguridad: solo permitimos volver al editor
  if (typeof v === 'string' && v.startsWith('/admin/editor')) return v;
  return '/admin/editor';
}

// ======================= PERSONAS =======================
router.post('/editor/persona/:id/editado', requireAuth, express.urlencoded({ extended: true }), async (req, res) => {
  const id = Number(req.params.id);
  const returnTo = safeReturnTo(req.body.returnTo);

  try {
    await dbExec(
      `UPDATE ordenes_personas
       SET editado = TRUE,
           editado_at = NOW()
       WHERE id = $1`,
      [id]
    );
  } catch (e) {
    console.error('❌ Error marcando editado (persona):', e);
  }
  res.redirect(returnTo);
});

router.post('/editor/persona/:id/impreso', requireAuth, express.urlencoded({ extended: true }), async (req, res) => {
  const id = Number(req.params.id);
  const returnTo = safeReturnTo(req.body.returnTo);

  try {
    await dbExec(
      `UPDATE ordenes_personas
       SET impresos = TRUE,
           impreso_at = NOW()
       WHERE id = $1`,
      [id]
    );
  } catch (e) {
    console.error('❌ Error marcando impreso (persona):', e);
  }
  res.redirect(returnTo);
});

// =================== INSTITUCIONES ======================
router.post('/editor/institucion/:id/editado', requireAuth, express.urlencoded({ extended: true }), async (req, res) => {
  const id = Number(req.params.id);
  const returnTo = safeReturnTo(req.body.returnTo);

  try {
    await dbExec(
      `UPDATE ordenes_instituciones
       SET editado = TRUE,
           editado_at = NOW()
       WHERE id = $1`,
      [id]
    );
  } catch (e) {
    console.error('❌ Error marcando editado (institucion):', e);
  }
  res.redirect(returnTo);
});

router.post('/editor/institucion/:id/impreso', requireAuth, express.urlencoded({ extended: true }), async (req, res) => {
  const id = Number(req.params.id);
  const returnTo = safeReturnTo(req.body.returnTo);

  try {
    await dbExec(
      `UPDATE ordenes_instituciones
       SET impresos = TRUE,
           impreso_at = NOW()
       WHERE id = $1`,
      [id]
    );
  } catch (e) {
    console.error('❌ Error marcando impreso (institucion):', e);
  }
  res.redirect(returnTo);
});




// ================================
// MARCAR COMO IMPRESO (personas)
// ================================
router.post(
  '/ordenes/persona/:id/marcar-impreso',
  requireAuth,
  express.urlencoded({ extended: true }),
  async (req, res) => {
    const id = Number(req.params.id);

    if (!id || id <= 0) {
      return res.redirect('/admin/editor');
    }

    try {
      // OJO: en BD seguimos usando "Entregado"
      // pero en el panel del editor lo mostraremos como "Impresos"
      await dbExec(
        'UPDATE ordenes_personas SET entrega = $1 WHERE id = $2',
        ['Entregado', id]
      );
    } catch (err) {
      console.error('❌ Error marcando impreso (persona):', err);
    }

    res.redirect('/admin/editor');
  }
);

// ================================
// MARCAR COMO IMPRESO (instituciones)
// ================================
router.post(
  '/ordenes/institucion/:id/marcar-impreso',
  requireAuth,
  express.urlencoded({ extended: true }),
  async (req, res) => {
    const id = Number(req.params.id);

    if (!id || id <= 0) {
      return res.redirect('/admin/editor');
    }

    try {
      await dbExec(
        'UPDATE ordenes_instituciones SET entrega = $1 WHERE id = $2',
        ['Entregado', id]
      );
    } catch (err) {
      console.error('❌ Error marcando impreso (institución):', err);
    }

    res.redirect('/admin/editor');
  }
);

// ---------------------------------------------------------------------------
// MARCAR COMO IMPRESOS (solo editor)
// ---------------------------------------------------------------------------
router.post(
  '/editor/impresos',
  requireAuth,
  express.urlencoded({ extended: true }),
  async (req, res) => {
    const id = Number(req.body.id);
    const tipo = (req.body.tipo || '').toLowerCase(); // 'persona' o 'institucion'

    if (!id || id <= 0 || !tipo) {
      return res.redirect('/admin/editor');
    }

    try {
      if (tipo === 'persona') {
        await dbExec(
          'UPDATE ordenes_personas SET impresos = true WHERE id = $1',
          [id]
        );
      } else if (tipo === 'institucion') {
        await dbExec(
          'UPDATE ordenes_instituciones SET impresos = true WHERE id = $1',
          [id]
        );
      }
    } catch (e) {
      console.error('❌ Error marcando como impresos:', e);
    }

    res.redirect('/admin/editor');
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
