// admin-panel.js
const path = require('path');
const express = require('express');
const session = require('express-session');
const fs = require('fs');

// ============================================================================
// RUTAS Y HELPERS COMPARTIDOS (data/…)
// ============================================================================

// Usamos la misma carpeta data que index.js
const DATA_DIR = path.join(process.cwd(), 'data');
const CONV_PATH = path.join(DATA_DIR, 'conversaciones.json');
const ORD_INST_PATH = path.join(DATA_DIR, 'ordenes-instituciones.json');
const ORD_PER_PATH = path.join(DATA_DIR, 'ordenes-personas.json');

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

  // Fechas recibidas del formulario (YYYY-MM-DD)
  const fechaDesde = (req.query.fecha_desde || '').trim();
  const fechaHasta = (req.query.fecha_hasta || '').trim();

  // Filtros adicionales
  const estado = (req.query.estado || '').trim();      // '' | Pendiente | Entregado
  const urgencia = (req.query.urgencia || '').trim();  // '' | Normal | Urgente | Muy urgente
  const texto = (req.query.q || '').trim().toLowerCase(); // búsqueda libre

  const ordenesInstitucionesAll = readJson(ORD_INST_PATH, []);
  const ordenesPersonasAll = readJson(ORD_PER_PATH, []);

  // Filtra por fecha_toma si se mandó rango
  function filtrarPorFecha(lista) {
    if (!fechaDesde && !fechaHasta) return lista;

    return (lista || []).filter((o) => {
      const f = (o.fecha_toma || '').slice(0, 10); // asumimos YYYY-MM-DD
      if (!f) return false;

      if (fechaDesde && f < fechaDesde) return false;
      if (fechaHasta && f > fechaHasta) return false;

      return true;
    });
  }

  // Filtra por estado / urgencia / texto
  function filtrarAvanzado(lista, tipo) {
    let out = filtrarPorFecha(lista);

    // Estado de entrega
    if (estado) {
      out = out.filter((o) => {
        const e = o.entrega || o.estado_entrega || 'Pendiente';
        return e === estado;
      });
    }

    // Urgencia
    if (urgencia) {
      out = out.filter((o) => {
        const u = o.urgencia || 'Normal';
        return u === urgencia;
      });
    }

    // Búsqueda de texto
    if (texto) {
      out = out.filter((o) => {
        let campos = [];
        if (tipo === 'inst') {
          campos = [
            o.institucion,
            o.seccion,
            o.paquete,
            o.telefono,
          ];
        } else {
          campos = [
            o.nombre,
            o.numero_orden,
            o.n_orden,
            o.numero_toma,
            o.n_toma,
            o.telefono,
          ];
        }

        return campos.some((c) =>
          typeof c === 'string' && c.toLowerCase().includes(texto)
        );
      });
    }

    return out;
  }

  const ordenesInstituciones = filtrarAvanzado(ordenesInstitucionesAll, 'inst');
  const ordenesPersonas = filtrarAvanzado(ordenesPersonasAll, 'per');

  res.render('ordenes', {
    title: 'Órdenes y libros',
    tab,
    ordenesInstituciones,
    ordenesPersonas,
    fechaDesde,
    fechaHasta,
    estadoFiltro: estado,
    urgenciaFiltro: urgencia,
    textoFiltro: texto,
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

      const nuevaOrden = {
        id: Date.now(),
        institucion: datos.institucion || '',
        seccion: datos.seccion || '',
        paquete: datos.paquete || '',
        toma_principal: Number(datos.toma_principal || 0),
        collage1: Number(datos.collage1 || 0),
        collage2: Number(datos.collage2 || 0),
        fecha_toma: datos.fecha_toma || '',
        telefono: datos.telefono || '',
        entrega: datos.entrega || 'Pendiente', // Pendiente / Entregado
        urgencia: datos.urgencia || 'Normal',  // Normal / Urgente / Muy urgente
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
      } = req.body || {};

      const lista = readJson(ORD_PER_PATH, []);

      lista.push({
        nombre: nombre || '',
        numero_orden: numero_orden || '',
        numero_toma: numero_toma || '',
        fecha_toma: fecha_toma || '',
        fecha_entrega: fecha_entrega || '',
        urgencia: urgencia || 'Normal',
        precio: Number(precio) || 0,
        telefono: telefono || '',
        entrega: estado_entrega || 'Pendiente', // 👈 campo que usa ordenes.ejs
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
      lista[idx] = {
        ...lista[idx],
        institucion: datos.institucion || '',
        seccion: datos.seccion || '',
        paquete: datos.paquete || '',
        toma_principal: Number(datos.toma_principal || 0),
        collage1: Number(datos.collage1 || 0),
        collage2: Number(datos.collage2 || 0),
        fecha_toma: datos.fecha_toma || '',
        telefono: datos.telefono || '',
        entrega: datos.entrega || 'Pendiente',
        urgencia: datos.urgencia || 'Normal',
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
      } = req.body || {};

      lista[idx] = {
        ...lista[idx],
        nombre: nombre || '',
        numero_orden: numero_orden || '',
        numero_toma: numero_toma || '',
        fecha_toma: fecha_toma || '',
        fecha_entrega: fecha_entrega || '',
        urgencia: urgencia || 'Normal',
        precio: Number(precio) || 0,
        telefono: telefono || '',
        entrega: estado_entrega || 'Pendiente',
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
  // HERRAMIENTAS IA (placeholder)
  // ---------------------------------------------------------------------------
  router.get('/herramientas', requireAuth, (req, res) => {
    res.render('placeholder', {
      title: 'Herramientas IA',
      subtitle:
        'Aquí podrás subir fotos/listas de estudiantes y convertirlas a texto limpio automáticamente.',
    });
  });

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
