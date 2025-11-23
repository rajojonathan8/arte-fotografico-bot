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
  // DASHBOARD PRINCIPAL
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

  router.get('/', requireAuth, (req, res) => {
    res.render('admin', { cards });
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
  router.get('/ordenes', requireAuth, (req, res) => {
    const tab = req.query.tab === 'personas' ? 'personas' : 'instituciones';

    // Filtros recibidos del formulario
    const fechaDesde = (req.query.fecha_desde || '').trim();
    const fechaHasta = (req.query.fecha_hasta || '').trim();
    const busqueda = (req.query.q || '').trim().toLowerCase();
    const filtroUrg = (req.query.urgencia || '').trim();
    const filtroEnt = (req.query.entrega || '').trim();
    const filtroPago = (req.query.pago || '').trim();

    const ordenesInstitucionesAll = readJson(ORD_INST_PATH, []);
    const ordenesPersonasAll = readJson(ORD_PER_PATH, []);

    function pasaFiltrosGenerales(o) {
      // Fecha de toma
      if (fechaDesde || fechaHasta) {
        const f = (o.fecha_toma || '').slice(0, 10);
        if (!f) return false;
        if (fechaDesde && f < fechaDesde) return false;
        if (fechaHasta && f > fechaHasta) return false;
      }

      // Texto libre
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

      // Urgencia
      if (filtroUrg) {
        const u = (o.urgencia || 'Normal').toLowerCase();
        if (u !== filtroUrg.toLowerCase()) return false;
      }

      // Entrega
      if (filtroEnt) {
        const e = (o.entrega || o.estado_entrega || 'Pendiente').toLowerCase();
        if (e !== filtroEnt.toLowerCase()) return false;
      }

      // Pago (solo aplica si el registro tiene precio/abono)
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
  (req, res) => {
    const datos = req.body || {};
    const lista = readJson(ORD_INST_PATH, []);

    const precioNum   = Number(datos.precio) || 0;
    let   abonoNum    = Number(datos.abono_inicial || 0);
    let   pagoEstado  = datos.pago_estado || 'Pendiente';

    // Ajustamos coherencia entre precio / abono / estado
    if (pagoEstado === 'Pagado' && precioNum > 0) {
      abonoNum = precioNum;
    } else {
      // Si no está en Pagado, calculamos según números
      pagoEstado = computePagoEstado(precioNum, abonoNum);
    }

    const nuevaOrden = {
      id: Date.now(),

      // 🔹 NUEVO: nombre del alumno/contacto
      nombre: datos.nombre || '',

      institucion: datos.institucion || '',
      seccion: datos.seccion || '',
      paquete: datos.paquete || '',
      toma_principal: Number(datos.toma_principal || 0),
      collage1: Number(datos.collage1 || 0),
      collage2: Number(datos.collage2 || 0),

      // 🔹 NUEVO: Collage 3
      collage3: Number(datos.collage3 || 0),

      fecha_toma: datos.fecha_toma || '',
      fecha_entrega: datos.fecha_entrega || '', 
      telefono: datos.telefono || '',
      entrega: datos.entrega || 'Pendiente',
      urgencia: datos.urgencia || 'Normal',

      // Pago
      precio: precioNum,
      abono: abonoNum,
      pago_estado: pagoEstado,
    };

    lista.push(nuevaOrden);
    writeJson(ORD_INST_PATH, lista);

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
    (req, res) => {
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

      const lista = readJson(ORD_PER_PATH, []);

      const precioNum = Number(precio) || 0;
      let abonoNum = getAbonoFromBody(datos);   // 👈 AQUÍ usamos el helper
      let pagoEstado = pago_estado || 'Pendiente';

      // Si marca "Pagado", el abono pasa a ser igual al precio
      if (pagoEstado === 'Pagado' && precioNum > 0) {
        abonoNum = precioNum;
      }

      // Si hay abono pero menor al precio → "Abono"
      if (abonoNum > 0 && abonoNum < precioNum && pagoEstado !== 'Pagado') {
        pagoEstado = 'Abono';
      }

      // Si abono 0 y estado "Abono" → lo regresamos a "Pendiente"
      if (abonoNum === 0 && pagoEstado === 'Abono') {
        pagoEstado = 'Pendiente';
      }

      lista.push({
        nombre: nombre || '',
        numero_orden: numero_orden || '',
        numero_toma: numero_toma || '',
        fecha_toma: fecha_toma || '',
        fecha_entrega: fecha_entrega || '',
        urgencia: urgencia || 'Normal',
        precio: precioNum,
        telefono: telefono || '',
        entrega: estado_entrega || 'Pendiente',

        abono: abonoNum,
        pago_estado: pagoEstado,
      });

      writeJson(ORD_PER_PATH, lista);
      res.redirect('/admin/ordenes?tab=personas');
    }
  );



  // ---------------------------------------------------------------------------
  // EDITAR ORDEN — INSTITUCIÓN
  // ---------------------------------------------------------------------------
  router.get('/ordenes/institucion/:idx/editar', requireAuth, (req, res) => {
    const idx = parseInt(req.params.idx, 10);
    const lista = readJson(ORD_INST_PATH, []);

    if (!Array.isArray(lista) || idx < 0 || idx >= lista.length) {
      return res.redirect('/admin/ordenes?tab=instituciones');
    }

    const orden = lista[idx];

    res.render('ordenes-editar-institucion.ejs', {
      title: 'Editar orden — institución',
      idx,
      orden,
    });
  });

router.post(
  '/ordenes/institucion/:idx/editar',
  requireAuth,
  express.urlencoded({ extended: true }),
  (req, res) => {
    const idx = parseInt(req.params.idx, 10);
    const lista = readJson(ORD_INST_PATH, []);

    if (!Array.isArray(lista) || idx < 0 || idx >= lista.length) {
      return res.redirect('/admin/ordenes?tab=instituciones');
    }

    const datos = req.body || {};
    const precioNum = Number(datos.precio) || 0;
    const abonoNum  = Number(datos.abono) || 0;

    const pagoEstado = computePagoEstado(precioNum, abonoNum);

    lista[idx] = {
      ...lista[idx],

      nombre: datos.nombre || '',       // 🔹 nuevo
      institucion: datos.institucion || '',
      seccion: datos.seccion || '',
      paquete: datos.paquete || '',
      toma_principal: Number(datos.toma_principal || 0),
      collage1: Number(datos.collage1 || 0),
      collage2: Number(datos.collage2 || 0),
      collage3: Number(datos.collage3 || 0), // 🔹 nuevo
      fecha_toma: datos.fecha_toma || '',
      fecha_entrega: datos.fecha_entrega || '',
      telefono: datos.telefono || '',
      entrega: datos.entrega || 'Pendiente',
      urgencia: datos.urgencia || 'Normal',

      precio: precioNum,
      abono: abonoNum,
      pago_estado: pagoEstado,
    };

    writeJson(ORD_INST_PATH, lista);
    res.redirect('/admin/ordenes?tab=instituciones');
  }
);


  // ---------------------------------------------------------------------------
  // EDITAR ORDEN — PERSONA
  // ---------------------------------------------------------------------------
  router.get('/ordenes/persona/:idx/editar', requireAuth, (req, res) => {
    const idx = parseInt(req.params.idx, 10);
    const lista = readJson(ORD_PER_PATH, []);

    if (!Array.isArray(lista) || idx < 0 || idx >= lista.length) {
      return res.redirect('/admin/ordenes?tab=personas');
    }

    const orden = lista[idx];

    res.render('ordenes-editar-persona.ejs', {
      title: 'Editar orden — persona',
      idx,
      orden,
    });
  });

    router.post(
    '/ordenes/persona/:idx/editar',
    requireAuth,
    express.urlencoded({ extended: true }),
    (req, res) => {
      const idx = parseInt(req.params.idx, 10);
      const lista = readJson(ORD_PER_PATH, []);

      if (!Array.isArray(lista) || idx < 0 || idx >= lista.length) {
        return res.redirect('/admin/ordenes?tab=personas');
      }

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
      } = datos;

      const precioNum = Number(precio) || 0;
      const abonoNum  = getAbonoFromBody(datos);   // 👈 AQUÍ

      // Estado de pago SOLO por números
      const pagoEstado = computePagoEstado(precioNum, abonoNum);

      lista[idx] = {
        ...lista[idx],
        nombre: nombre || '',
        numero_orden: numero_orden || '',
        numero_toma: numero_toma || '',
        fecha_toma: fecha_toma || '',
        fecha_entrega: fecha_entrega || '',
        urgencia: urgencia || 'Normal',
        precio: precioNum,
        telefono: telefono || '',
        entrega: estado_entrega || 'Pendiente',

        abono: abonoNum,
        pago_estado: pagoEstado,
      };

      writeJson(ORD_PER_PATH, lista);
      res.redirect('/admin/ordenes?tab=personas');
    }
  );


  // ---------------------------------------------------------------------------
  // ELIMINAR ORDEN — INSTITUCIÓN
  // ---------------------------------------------------------------------------
  router.post(
    '/ordenes/institucion/:idx/eliminar',
    requireAuth,
    express.urlencoded({ extended: true }),
    (req, res) => {
      const idx = parseInt(req.params.idx, 10);
      let lista = readJson(ORD_INST_PATH, []);

      if (!Array.isArray(lista) || idx < 0 || idx >= lista.length) {
        return res.redirect('/admin/ordenes?tab=instituciones');
      }

      lista.splice(idx, 1);
      writeJson(ORD_INST_PATH, lista);

      res.redirect('/admin/ordenes?tab=instituciones');
    }
  );

  // ---------------------------------------------------------------------------
  // ELIMINAR ORDEN — PERSONA
  // ---------------------------------------------------------------------------
  router.post(
    '/ordenes/persona/:idx/eliminar',
    requireAuth,
    express.urlencoded({ extended: true }),
    (req, res) => {
      const idx = parseInt(req.params.idx, 10);
      let lista = readJson(ORD_PER_PATH, []);

      if (!Array.isArray(lista) || idx < 0 || idx >= lista.length) {
        return res.redirect('/admin/ordenes?tab=personas');
      }

      lista.splice(idx, 1);
      writeJson(ORD_PER_PATH, lista);

      res.redirect('/admin/ordenes?tab=personas');
    }
  );

  // ---------------------------------------------------------------------------
  // DETALLE ORDEN — INSTITUCIÓN
  // ---------------------------------------------------------------------------
  router.get('/ordenes/institucion/:idx', requireAuth, (req, res) => {
    const idx = parseInt(req.params.idx, 10);
    const lista = readJson(ORD_INST_PATH, []);

    if (!Array.isArray(lista) || idx < 0 || idx >= lista.length) {
      return res.redirect('/admin/ordenes?tab=instituciones');
    }

    const orden = lista[idx];

    res.render('orden-detalle', {
      title: 'Detalle de orden — institución',
      tipo: 'institucion',
      idx,
      orden,
    });
  });

  // ---------------------------------------------------------------------------
  // DETALLE ORDEN — PERSONA
  // ---------------------------------------------------------------------------
  router.get('/ordenes/persona/:idx', requireAuth, (req, res) => {
    const idx = parseInt(req.params.idx, 10);
    const lista = readJson(ORD_PER_PATH, []);

    if (!Array.isArray(lista) || idx < 0 || idx >= lista.length) {
      return res.redirect('/admin/ordenes?tab=personas');
    }

    const orden = lista[idx];

    res.render('orden-detalle', {
      title: 'Detalle de orden — persona',
      tipo: 'persona',
      idx,
      orden,
    });
  });

  // ---------------------------------------------------------------------------
  // CAMBIAR ESTADO DE ENTREGA — PERSONAS
  // ---------------------------------------------------------------------------
  router.post(
    '/ordenes/persona/entrega',
    requireAuth,
    express.urlencoded({ extended: true }),
    (req, res) => {
      const idx = parseInt(req.body.idx, 10);
      const nuevoEstado =
        req.body.estado === 'Entregado' ? 'Entregado' : 'Pendiente';

      const lista = readJson(ORD_PER_PATH, []);

      if (Array.isArray(lista) && idx >= 0 && idx < lista.length) {
        lista[idx].entrega = nuevoEstado;
        writeJson(ORD_PER_PATH, lista);
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
    (req, res) => {
      const { idx, estado } = req.body;
      const i = parseInt(idx, 10);
      const nuevoEstado = estado === 'Entregado' ? 'Entregado' : 'Pendiente';

      const lista = readJson(ORD_INST_PATH, []);

      if (Array.isArray(lista) && i >= 0 && i < lista.length) {
        lista[i].entrega = nuevoEstado;
        writeJson(ORD_INST_PATH, lista);
      }

      res.redirect('/admin/ordenes?tab=instituciones');
    }
  );

  // ---------------------------------------------------------------------------
  // ABONAR / MARCAR PAGADO — PERSONAS
  // ---------------------------------------------------------------------------
  router.post(
    '/ordenes/persona/:idx/abonar',
    requireAuth,
    express.urlencoded({ extended: true }),
    (req, res) => {
      const idx = parseInt(req.params.idx, 10);
      const monto = Number(req.body.monto) || 0;
      const lista = readJson(ORD_PER_PATH, []);

      if (!Array.isArray(lista) || idx < 0 || idx >= lista.length || monto <= 0) {
        return res.redirect('/admin/ordenes?tab=personas');
      }

      const item = lista[idx];
      const precio = Number(item.precio) || 0;
      const abonoActual = Number(item.abono) || 0;
      let nuevoAbono = abonoActual + monto;

      if (nuevoAbono > precio) nuevoAbono = precio;

      item.abono = nuevoAbono;
      item.pago_estado = computePagoEstado(precio, nuevoAbono);

      writeJson(ORD_PER_PATH, lista);
      res.redirect('/admin/ordenes?tab=personas');
    }
  );

  router.post(
    '/ordenes/persona/:idx/marcar-pagado',
    requireAuth,
    express.urlencoded({ extended: true }),
    (req, res) => {
      const idx = parseInt(req.params.idx, 10);
      const lista = readJson(ORD_PER_PATH, []);

      if (!Array.isArray(lista) || idx < 0 || idx >= lista.length) {
        return res.redirect('/admin/ordenes?tab=personas');
      }

      const item = lista[idx];
      const precio = Number(item.precio) || 0;

      item.abono = precio;
      item.pago_estado = 'Pagado';

      writeJson(ORD_PER_PATH, lista);
      res.redirect('/admin/ordenes?tab=personas');
    }
  );

  // ---------------------------------------------------------------------------
  // ABONAR / MARCAR PAGADO — INSTITUCIONES
  // ---------------------------------------------------------------------------
  router.post(
    '/ordenes/institucion/:idx/abonar',
    requireAuth,
    express.urlencoded({ extended: true }),
    (req, res) => {
      const idx = parseInt(req.params.idx, 10);
      const monto = Number(req.body.monto) || 0;
      const lista = readJson(ORD_INST_PATH, []);

      if (!Array.isArray(lista) || idx < 0 || idx >= lista.length || monto <= 0) {
        return res.redirect('/admin/ordenes?tab=instituciones');
      }

      const item = lista[idx];
      const precio = Number(item.precio) || 0;
      const abonoActual = Number(item.abono) || 0;
      let nuevoAbono = abonoActual + monto;

      if (nuevoAbono > precio) nuevoAbono = precio;

      item.abono = nuevoAbono;
      item.pago_estado = computePagoEstado(precio, nuevoAbono);

      writeJson(ORD_INST_PATH, lista);
      res.redirect('/admin/ordenes?tab=instituciones');
    }
  );

  router.post(
    '/ordenes/institucion/:idx/marcar-pagado',
    requireAuth,
    express.urlencoded({ extended: true }),
    (req, res) => {
      const idx = parseInt(req.params.idx, 10);
      const lista = readJson(ORD_INST_PATH, []);

      if (!Array.isArray(lista) || idx < 0 || idx >= lista.length) {
        return res.redirect('/admin/ordenes?tab=instituciones');
      }

      const item = lista[idx];
      const precio = Number(item.precio) || 0;

      item.abono = precio;
      item.pago_estado = 'Pagado';

      writeJson(ORD_INST_PATH, lista);
      res.redirect('/admin/ordenes?tab=instituciones');
    }
  );

  // ---------------------------------------------------------------------------
  // RECIBO — PERSONA (HTML imprimible media carta)
  // ---------------------------------------------------------------------------
  router.get(
    '/ordenes/persona/:idx/recibo',
    requireAuth,
    (req, res) => {
      const idx = parseInt(req.params.idx, 10);
      const lista = readJson(ORD_PER_PATH, []);

      if (!Array.isArray(lista) || idx < 0 || idx >= lista.length) {
        return res.redirect('/admin/ordenes?tab=personas');
      }

      const orden = lista[idx];
      const precio = Number(orden.precio || 0);
      const abono = Number(orden.abono || 0);
      const saldo = Math.max(precio - abono, 0);
      const pagoEstado = derivePagoEstado(orden);

      res.render('orden-recibo.ejs', {
        title: 'Recibo — persona',
        tipo: 'persona',
        idx,
        orden,
        precio,
        abono,
        saldo,
        pagoEstado,
      });
    }
  );

  // ---------------------------------------------------------------------------
  // RECIBO — INSTITUCIÓN (HTML imprimible media carta)
  // ---------------------------------------------------------------------------
  router.get(
    '/ordenes/institucion/:idx/recibo',
    requireAuth,
    (req, res) => {
      const idx = parseInt(req.params.idx, 10);
      const lista = readJson(ORD_INST_PATH, []);

      if (!Array.isArray(lista) || idx < 0 || idx >= lista.length) {
        return res.redirect('/admin/ordenes?tab=instituciones');
      }

      const orden = lista[idx];
      const precio = Number(orden.precio || 0);
      const abono = Number(orden.abono || 0);
      const saldo = Math.max(precio - abono, 0);
      const pagoEstado = derivePagoEstado(orden);

      res.render('orden-recibo.ejs', {
        title: 'Recibo — institución',
        tipo: 'institucion',
        idx,
        orden,
        precio,
        abono,
        saldo,
        pagoEstado,
      });
    }
  );

  // ---------------------------------------------------------------------------
  // PANEL DE CITAS
  // ---------------------------------------------------------------------------
  router.get('/citas', requireAuth, (req, res) => {
    const fechaDesde = (req.query.fecha_desde || '').trim();
    const fechaHasta = (req.query.fecha_hasta || '').trim();
    const busqueda   = (req.query.q || '').trim().toLowerCase();
    const estadoFil  = (req.query.estado || '').trim().toLowerCase();

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
        const texto = [
          c.cliente,
          c.sesion,
          c.telefono,
          c.notas,
        ]
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
        origen: 'manual',   // luego podemos poner google-calendar
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

      const nuevoEstado = ['Pendiente', 'Atendida', 'Cancelada'].includes(estado)
        ? estado
        : 'Pendiente';

      lista[idx].estado = nuevoEstado;
      writeJson(CITAS_PATH, lista);

      res.redirect('/admin/citas');
    }
  );



  // ---------------------------------------------------------------------------
// TICKET 80 mm — PERSONA
// ---------------------------------------------------------------------------
router.get(
  '/ordenes/persona/:idx/ticket',
  requireAuth,
  (req, res) => {
    const idx = parseInt(req.params.idx, 10);
    const lista = readJson(ORD_PER_PATH, []);

    if (!Array.isArray(lista) || idx < 0 || idx >= lista.length) {
      return res.redirect('/admin/ordenes?tab=personas');
    }

    const orden = lista[idx];
    const precio = Number(orden.precio || 0);
    const abono  = Number(orden.abono  || 0);
    const saldo  = Math.max(precio - abono, 0);
    const pagoEstado = derivePagoEstado(orden);

    res.render('orden-ticket.ejs', {
      title: 'Ticket — persona',
      tipo: 'persona',
      idx,
      orden,
      precio,
      abono,
      saldo,
      pagoEstado,
    });
  }
);

// ---------------------------------------------------------------------------
// TICKET 80 mm — INSTITUCIÓN
// ---------------------------------------------------------------------------
router.get(
  '/ordenes/institucion/:idx/ticket',
  requireAuth,
  (req, res) => {
    const idx = parseInt(req.params.idx, 10);
    const lista = readJson(ORD_INST_PATH, []);

    if (!Array.isArray(lista) || idx < 0 || idx >= lista.length) {
      return res.redirect('/admin/ordenes?tab=instituciones');
    }

    const orden = lista[idx];
    const precio = Number(orden.precio || 0);
    const abono  = Number(orden.abono  || 0);
    const saldo  = Math.max(precio - abono, 0);
    const pagoEstado = derivePagoEstado(orden);

    res.render('orden-ticket.ejs', {
      title: 'Ticket — institución',
      tipo: 'institucion',
      idx,
      orden,
      precio,
      abono,
      saldo,
      pagoEstado,
    });
  }
);


 // ---------------------------------------------------------------------------
// HERRAMIENTAS OCR
// ---------------------------------------------------------------------------
router.get('/herramientas', requireAuth, (req, res) => {
  // Si ya tienes texto del OCR desde un POST, aquí podrías pasarlo en "ocrText"
  res.render('herramientas-ocr', {
    title: 'Herramientas OCR',
    ocrText: '', // por ahora vacío; luego lo llenamos desde tu backend de OCR
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
      // 1️⃣ Preprocesar la imagen: agrandar, blanco y negro, más contraste
      await sharp(imagenPath)
        .resize({ width: 1800, withoutEnlargement: false }) // la agrandamos a ~1800 px de ancho
        .grayscale()
        .normalize()               // mejora contraste
        .toFile(preprocesadaPath); // guardamos imagen procesada

      // 2️⃣ Pasar la imagen procesada a Tesseract
      const result = await Tesseract.recognize(
        preprocesadaPath,
        'spa+eng', // español + algo de inglés/números
        {
          logger: m => console.log('[OCR]', m), // opcional, progreso en consola
        }
      );

      textoDelOcr = (result.data && result.data.text) ? result.data.text : '';

      // Limpieza básica de saltos de línea
      textoDelOcr = textoDelOcr
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    } catch (err) {
      console.error('❌ Error en OCR:', err);
      textoDelOcr = 'Ocurrió un error al procesar la imagen con OCR.\n' +
                    'Revisa la consola del servidor para más detalles.';
    } finally {
      // Borramos archivos temporales
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
