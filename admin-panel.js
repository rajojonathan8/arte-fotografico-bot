// admin-panel.js
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');

const CONVERS_PATH = path.join(__dirname, 'data', 'conversaciones.json');

function cargarConversacionesPanel() {
  try {
    if (!fs.existsSync(CONVERS_PATH)) return [];
    const raw = fs.readFileSync(CONVERS_PATH, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('❌ Error leyendo conversaciones para el panel:', e.message);
    return [];
  }
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

  // Middleware de protección
  function requireAuth(req, res, next) {
    if (req.session && req.session.isAdmin) return next();
    return res.redirect('/admin/login');
  }

  // ===== RUTAS DEL PANEL =====

  // Login (GET)
  router.get('/login', (req, res) => {
    res.render('login', {
      title: 'Panel de Empleados',  // 👈 añadimos title
      error: null                   // 👈 y error nulo
    });
  });

  // Login (POST)
  router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
    const { pin } = req.body || {};
    if (pin === ADMIN_PIN) {
      req.session.isAdmin = true;
      return res.redirect('/admin');
    }
    return res.render('login', {
      title: 'Panel de Empleados',                      // 👈 también title aquí
      error: 'PIN incorrecto. Intenta de nuevo.'       // 👈 error con mensaje
    });
  });

    // ---- Tarjetas del dashboard (AQUÍ definimos "cards") ----
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
      desc: 'Subir listas de estudiantes, convertir texto y ayudar con tareas repetitivas.',
    },
  ];

  // Dashboard principal
  router.get('/', requireAuth, (req, res) => {
    res.render('admin', { cards });
  });

  // ======================= CHAT (vista con datos de prueba) =======================
 

    router.get('/chat', requireAuth, (req, res) => {
    const conversations = cargarConversacionesPanel();
    res.render('chat', {
      title: 'Chat con clientes',
      conversations,
    });
  });


  // De momento, las otras secciones siguen como placeholder
  router.get('/ordenes', requireAuth, (req, res) => {
    res.render('placeholder', {
      title: 'Órdenes y libros',
      subtitle:
        'Aquí registraremos las órdenes de instituciones y personas (libros físicos pasados al sistema).',
    });
  });

  router.get('/herramientas', requireAuth, (req, res) => {
    res.render('placeholder', {
      title: 'Herramientas IA',
      subtitle:
        'Aquí podrás subir fotos/listas de estudiantes y convertirlas a texto limpio automáticamente.',
    });
  });

  // Logout sencillo (por si luego quieres)
  router.get('/logout', (req, res) => {
    req.session.destroy(() => {
      res.redirect('/admin/login');
    });
  });

  // Montar router bajo /admin
  app.use('/admin', router);
}

module.exports = mountAdmin;
