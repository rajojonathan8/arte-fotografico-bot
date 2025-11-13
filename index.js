// index.js
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { google } = require('googleapis');
const mountAdmin = require('./admin-panel'); // panel de empleados

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Entorno
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''; // opcional

// ===== Config fijos
const VERIFY_TOKEN = 'MI_TOKEN_SECRETO_ARTE_FOTOGRAFICO';
const PHONE_NUMBER_ID = '805856909285040';

// Dirección fija (usada por IA)
const ADDRESS_TEXT =
  'Calle Masferrer, Av. Morazán, 2ª Av. Norte #1-2, entre Piedra Lisa y Casa de Cultura de Sonsonate, enfrente de Academia Patty.';
const MAPS_LINK = 'https://maps.app.goo.gl/7GWy4QG27d9Jdw9G9';

// ===== Estado por usuario (flujo guiado de citas)
const estadosUsuarios = {}; // { [tel]: { paso, datos: { nombre, fechaHora, tipoSesion, telefono } } }

// =====================================================================================
//                         1) REGISTRO DE CONVERSACIONES (JSON)
// =====================================================================================
const DATA_DIR = path.join(process.cwd(), 'data');
const CONV_PATH = path.join(DATA_DIR, 'conversaciones.json');

// Asegura carpeta y archivo
function ensureConvFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
    if (!fs.existsSync(CONV_PATH)) fs.writeFileSync(CONV_PATH, '[]', 'utf8');
  } catch (e) {
    console.error('❌ Error preparando conversaciones.json:', e.message);
  }
}

function loadConversaciones() {
  try {
    ensureConvFile();
    const raw = fs.readFileSync(CONV_PATH, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    console.error('❌ Error leyendo conversaciones.json:', e.message);
    return [];
  }
}

function saveConversaciones(arr) {
  try {
    ensureConvFile();
    fs.writeFileSync(CONV_PATH, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) {
    console.error('❌ Error guardando conversaciones.json:', e.message);
  }
}

/**
 * Registra un mensaje en el historial del cliente
 * @param {string} phone - número de WhatsApp (ej: "50371234567")
 * @param {string} name  - nombre del contacto (si hay)
 * @param {"cliente"|"bot"} lado - quién envía
 * @param {string} text
 * @param {number} [ts] - timestamp ms
 */
function registrarMensaje(phone, name, lado, text, ts) {
  if (!phone || !text) return;
  const timestamp = ts || Date.now();
  const tel = phone.toString();

  const convs = loadConversaciones();
  let conv = convs.find((c) => c.phone === tel);

  if (!conv) {
    conv = {
      phone: tel,
      name: name || 'Cliente sin nombre',
      messages: [],
      lastUpdate: timestamp,
    };
    convs.push(conv);
  } else {
    if (name && name.trim()) conv.name = name;
    conv.lastUpdate = timestamp;
  }

  conv.messages.push({
    from: lado,
    text,
    timestamp,
  });

  saveConversaciones(convs);
}

// =====================================================================================
//                              2) CATÁLOGO LOCAL (servicios.json)
// =====================================================================================
let CATALOGO = [];
const CATALOGO_PATH = path.join(process.cwd(), 'servicios.json');

function normalizarTexto(t) {
  return (t || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function claves(...arr) {
  return arr
    .flat()
    .filter(Boolean)
    .map((x) => normalizarTexto(x));
}

function cargarCatalogo() {
  try {
    if (!fs.existsSync(CATALOGO_PATH)) {
      console.warn('⚠️ No existe servicios.json en la raíz.');
      return;
    }
    const raw = fs.readFileSync(CATALOGO_PATH, 'utf8');
    const data = JSON.parse(raw);

    const items = [];

    // Títulos y documentos
    for (const it of data?.foto_estudio?.titulos_documentos || []) {
      items.push({
        tipo: 'servicio',
        nombre: it.servicio,
        precio: it.precio,
        duracion_min: it.duracion_min,
        tamano: it.tamano,
        requisitos: it.tipo_foto,
        vestimenta_senoritas: it.vestimenta_senoritas,
        vestimenta_caballeros: it.vestimenta_caballeros,
        observaciones: it.observaciones,
        _nombres: claves(
          it.servicio,
          it.tamano ? `${it.servicio} ${it.tamano}` : null,
          'titulo',
          'foto titulo',
          'fotografia titulo'
        ),
      });
    }

    // Migratorios (Visa)
    for (const it of data?.foto_estudio?.migratorios || []) {
      items.push({
        tipo: 'servicio',
        nombre: it.servicio,
        precio: it.precio,
        duracion_min: it.duracion_min,
        tamano: it.tamano,
        requisitos: it.tipo_foto,
        cantidad_fotos: it.cantidad_fotos,
        vestimenta_senoritas: it.vestimenta_senoritas,
        vestimenta_caballeros: it.vestimenta_caballeros,
        observaciones: it.observaciones,
        _nombres: claves(
          it.servicio,
          'visa',
          it.tamano,
          'foto visa',
          'foto para visa',
          it.servicio && `foto ${it.servicio}`
        ),
      });
    }

    // Impresión aficionado
    for (const it of data?.impresion_fotografica?.aficionado?.precios || []) {
      items.push({
        tipo: 'impresion',
        linea: 'aficionado',
        nombre: `Impresión ${it.tamano}`,
        tamano: it.tamano,
        precio: it.precio,
        detalles: data?.impresion_fotografica?.aficionado?.nota_tecnica,
        _nombres: claves(
          `impresion ${it.tamano}`,
          `foto ${it.tamano}`,
          it.tamano,
          it.tamano?.replace('x', ' x ')
        ),
      });
    }

    // Impresión profesional
    for (const it of data?.impresion_fotografica?.profesional?.precios || []) {
      items.push({
        tipo: 'impresion',
        linea: 'profesional',
        nombre: `Impresión ${it.tamano}`,
        tamano: it.tamano,
        precio: it.precio,
        detalles: 'Línea profesional',
        _nombres: claves(
          `impresion ${it.tamano}`,
          `foto ${it.tamano}`,
          it.tamano,
          it.tamano?.replace('x', ' x ')
        ),
      });
    }

    // Sesiones fotográficas (informativo)
    if (data?.foto_estudio?.sesiones_fotograficas?.tipos?.length) {
      items.push({
        tipo: 'informativo',
        nombre: 'Sesiones fotográficas',
        detalles: data.foto_estudio.sesiones_fotograficas.nota_atencion,
        _nombres: claves('sesion', 'sesiones', ...data.foto_estudio.sesiones_fotograficas.tipos),
      });
    }

    // Retratos especiales (informativo)
    if (data?.foto_estudio?.retratos_especiales?.tipos?.length) {
      items.push({
        tipo: 'informativo',
        nombre: 'Retratos especiales',
        detalles: data.foto_estudio.retratos_especiales.nota_atencion,
        _nombres: claves('retratos', 'retrato', ...data.foto_estudio.retratos_especiales.tipos),
      });
    }

    CATALOGO = items;
    console.log(`📚 Catálogo indexado: ${CATALOGO.length} ítems.`);
  } catch (e) {
    console.error('❌ Error cargando servicios.json:', e.message);
  }
}
cargarCatalogo();

function buscarEnCatalogo(mensajeUsuario) {
  const q = normalizarTexto(mensajeUsuario);
  if (!q || !CATALOGO.length) return null;
  let mejor = null;
  let mejorScore = 0;
  for (const it of CATALOGO) {
    for (const key of it._nombres || []) {
      if (q.includes(key) && key.length > mejorScore) {
        mejorScore = key.length;
        mejor = it;
      }
    }
  }
  return mejor;
}

function money(n) {
  return typeof n === 'number' ? `$${n.toFixed(2)}` : n;
}

function formatearRespuestaCatalogo(it) {
  if (!it) return null;

  if (it.tipo === 'servicio') {
    let out = `ℹ️ *${it.nombre}*\n\n`;
    if (it.precio != null) out += `💲 Precio: ${money(it.precio)}\n`;
    if (it.duracion_min) out += `⏱️ Duración: ${it.duracion_min} minutos\n`;
    if (it.tamano) out += `📐 Tamaño: ${it.tamano}\n`;
    if (it.requisitos) out += `📌 Requisitos: ${it.requisitos}\n`;
    if (it.cantidad_fotos) out += `🖼️ Cantidad de fotos: ${it.cantidad_fotos}\n`;
    if (it.vestimenta_senoritas) out += `👗 Señoritas: ${it.vestimenta_senoritas}\n`;
    if (it.vestimenta_caballeros) out += `🤵 Caballeros: ${it.vestimenta_caballeros}\n`;
    if (it.observaciones) out += `📝 Observaciones: ${it.observaciones}\n`;
    out += `\n¿Deseas agendar? Envía *5* y te guío.`;
    return out.trim();
  }

  if (it.tipo === 'impresion') {
    let out = `🖨️ *${it.nombre}* (${it.linea})\n`;
    if (it.precio != null) out += `💲 Precio: ${money(it.precio)}\n`;
    if (it.detalles) out += `📝 Detalles: ${it.detalles}\n`;
    out += `\n¿Cantidad y tamaños que necesitas? Puedo ayudarte a calcular el total.`;
    return out.trim();
  }

  let out = `ℹ️ *${it.nombre}*\n`;
  if (it.detalles) out += `${it.detalles}\n`;
  out += `\nSi deseas, te conecto con un asesor o te comparto la dirección del local.`;
  return out.trim();
}

// =====================================================================================
//                                  3) GOOGLE CALENDAR
// =====================================================================================
let serviceAccount = null;
if (GOOGLE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
  } catch (e) {
    console.error('❌ GOOGLE_SERVICE_ACCOUNT inválido:', e.message);
  }
}

async function getCalendarClient() {
  try {
    if (!serviceAccount?.client_email || !serviceAccount?.private_key) return null;
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    const authClient = await auth.getClient();
    return google.calendar({ version: 'v3', auth: authClient });
  } catch (e) {
    console.error('❌ getCalendarClient:', e.message);
    return null;
  }
}

function formatearFechaHoraLocal(dateObj) {
  const opt = {
    timeZone: 'America/El_Salvador',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  const parts = new Intl.DateTimeFormat('en-CA', opt).formatToParts(dateObj);
  const grab = (t) => parts.find((p) => p.type === t)?.value;
  return `${grab('year')}-${grab('month')}-${grab('day')} ${grab('hour')}:${grab('minute')}`;
}

async function crearCitaEnCalendar(fechaHoraTexto, tipoSesion, telefono, nombreCliente) {
  try {
    const calendar = await getCalendarClient();
    if (!calendar || !GOOGLE_CALENDAR_ID) return false;

    const [fechaStr, horaStr] = fechaHoraTexto.split(' ');
    const [Y, M, D] = fechaStr.split('-').map(Number);
    const [h, m] = horaStr.split(':').map(Number);
    const pad2 = (n) => String(n).padStart(2, '0');

    const ini = `${Y}-${pad2(M)}-${pad2(D)}T${pad2(h)}:${pad2(m)}:00`;
    const minutos = h * 60 + m + 60;
    const hf = Math.floor(minutos / 60);
    const mf = minutos % 60;
    const fin = `${Y}-${pad2(M)}-${pad2(D)}T${pad2(hf)}:${pad2(mf)}:00`;

    const evento = {
      summary: `Sesión ${tipoSesion || 'fotográfica'} - ${nombreCliente || 'Cliente WhatsApp'}`,
      description:
        `Sesión agendada desde el bot de Arte Fotográfico.\n` +
        (nombreCliente ? `Nombre: ${nombreCliente}\n` : '') +
        `Teléfono: ${telefono || ''}`,
      start: { dateTime: ini, timeZone: 'America/El_Salvador' },
      end: { dateTime: fin, timeZone: 'America/El_Salvador' },
    };

    await calendar.events.insert({ calendarId: GOOGLE_CALENDAR_ID, requestBody: evento });
    return true;
  } catch (e) {
    console.error('❌ crearCitaEnCalendar:', e.response?.data || e.message);
    return false;
  }
}

async function cancelarCitaEnCalendar(fechaHoraTexto, telefono) {
  try {
    const calendar = await getCalendarClient();
    if (!calendar || !GOOGLE_CALENDAR_ID) return false;

    const [fechaStr] = fechaHoraTexto.split(' ');
    const [Y, M, D] = fechaStr.split('-').map(Number);

    const timeMin = new Date(Y, M - 1, D, 0, 0, 0).toISOString();
    const timeMax = new Date(Y, M - 1, D, 23, 59, 59).toISOString();

    const resp = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const tel = (telefono || '').replace(/[^0-9]/g, '');
    const ult4 = tel.slice(-4);

    for (const ev of resp.data.items || []) {
      const desc = (ev.description || '').toLowerCase();
      const sum = (ev.summary || '').toLowerCase();
      const fechaTxt = ev.start?.dateTime
        ? formatearFechaHoraLocal(new Date(ev.start.dateTime))
        : '';
      const coincideFecha = fechaTxt === fechaHoraTexto;
      const coincideTel = desc.includes(tel) || sum.includes(tel) || (ult4 && desc.includes(ult4));
      if (coincideFecha && coincideTel) {
        await calendar.events.delete({ calendarId: GOOGLE_CALENDAR_ID, eventId: ev.id });
        return true;
      }
    }
    return false;
  } catch (e) {
    console.error('❌ cancelarCitaEnCalendar:', e.response?.data || e.message);
    return false;
  }
}

async function listarCitasPorTelefono(telefono) {
  try {
    const calendar = await getCalendarClient();
    if (!calendar || !GOOGLE_CALENDAR_ID) return [];
    const ahora = new Date();
    const en30 = new Date(ahora.getTime() + 30 * 24 * 60 * 60 * 1000);
    const resp = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: ahora.toISOString(),
      timeMax: en30.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const tel = (telefono || '').replace(/[^0-9]/g, '');
    const ult4 = tel.slice(-4);
    const out = [];

    for (const ev of resp.data.items || []) {
      const desc = (ev.description || '').toLowerCase();
      const sum = (ev.summary || '').toLowerCase();
      const coincideTel = desc.includes(tel) || sum.includes(tel) || (ult4 && desc.includes(ult4));
      if (!coincideTel) continue;
      const fecha = ev.start?.dateTime ? formatearFechaHoraLocal(new Date(ev.start.dateTime)) : '';
      out.push({ fecha, resumen: ev.summary || 'Cita' });
    }
    return out;
  } catch (e) {
    console.error('❌ listarCitasPorTelefono:', e.response?.data || e.message);
    return [];
  }
}

// =====================================================================================
//                                      4) HORARIO
// =====================================================================================
function esHorarioLaboralActual() {
  const loc = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/El_Salvador' }));
  const d = loc.getDay(); // 0 dom, 6 sáb
  const h = loc.getHours();
  const m = loc.getMinutes();
  const hd = h + m / 60;
  if (d >= 1 && d <= 5) return (hd >= 8 && hd <= 12.5) || (hd >= 14 && hd <= 18);
  if (d === 6) return hd >= 8 && hd <= 12.5;
  return false;
}
function esDomingo() {
  const loc = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/El_Salvador' }));
  return loc.getDay() === 0;
}
function esHorarioLaboralEnFecha(fechaHoraTexto) {
  const [f, hRaw] = (fechaHoraTexto || '').split(' ');
  if (!f || !hRaw) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(hRaw)) return false;
  const [Y, M, D] = f.split('-').map(Number);
  const [h, m] = hRaw.split(':').map(Number);
  const d = new Date(Y, M - 1, D, h, m);
  const dow = d.getDay();
  const hd = h + m / 60;
  if (dow >= 1 && dow <= 5) return (hd >= 8 && hd <= 12.5) || (hd >= 14 && hd <= 18);
  if (dow === 6) return hd >= 8 && hd <= 12.5;
  return false;
}
function normalizarHora(h) {
  const [H, M] = h.split(':').map(Number);
  return `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`;
}

// =====================================================================================
//                                         5) IA (OpenAI)
// =====================================================================================
async function askOpenAI(prompt) {
  if (!OPENAI_API_KEY) return null;
  try {
    const r = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'Eres el Asistente Arte Fotográfico. Responde en español, con tono amable, profesional y conciso. ' +
              'Negocio en Sonsonate, El Salvador. Usa datos exactos solo si el usuario los dio o están confirmados. ' +
              `Dirección del local: ${ADDRESS_TEXT}. Enlace de Maps: ${MAPS_LINK}.`,
          },
          { role: 'user', content: prompt },
        ],
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    return r.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('❌ OpenAI:', e.response?.data || e.message);
    return null;
  }
}

// =====================================================================================
//                                      6) WHATSAPP
// =====================================================================================
app.use(bodyParser.json());

// Montamos el panel de empleados
mountAdmin(app);

app.get('/', (_, res) => res.send('Servidor Arte Fotográfico activo 🚀'));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const tokenVerify = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && tokenVerify === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

async function sendWhatsAppMessage(to, text, opts = {}) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(
      url,
      { messaging_product: 'whatsapp', to, text: { body: text } },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );

    // Log de respuesta del bot
    if (opts.log) {
      registrarMensaje(opts.phone || to, 'Arte Fotográfico', 'bot', text);
    }
  } catch (e) {
    console.error('❌ WhatsApp send:', e.response?.data || e.message);
  }
}

app.post('/webhook', async (req, res) => {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const texto = (message.text?.body || '').trim();
    const low = texto.toLowerCase();

    // nombre del contacto (si lo manda WhatsApp)
    const contact = value?.contacts?.[0];
    const contactName = contact?.profile?.name || 'Cliente sin nombre';

    // Registramos mensaje del cliente en el historial
    registrarMensaje(from, contactName, 'cliente', texto, Number(message.timestamp || Date.now()) * 1000);

    // Fuera de horario actual
    if (!esHorarioLaboralActual()) {
      const out = esDomingo()
        ? '📸 *Gracias por contactarnos con Arte Fotográfico.*\n\n' +
          'Hoy es *domingo* y estamos *cerrados* por descanso del personal.\n\n' +
          '🕓 *Horario:*\nL-V: 8:00–12:30 y 14:00–18:00\nSáb: 8:00–12:30\n\n' +
          'Déjanos tu mensaje y te respondemos al abrir. 😊'
        : '📸 *Gracias por contactarnos con Arte Fotográfico.*\n\n' +
          'Ahora estamos *fuera de horario*, te responderemos en cuanto estemos de vuelta. 😊\n\n' +
          '🕓 *Horario:*\nL-V: 8:00–12:30 y 14:00–18:00\nSáb: 8:00–12:30';
      await sendWhatsAppMessage(from, out, { log: true, phone: from });
      return res.sendStatus(200);
    }

    // ================== Cancelar flujo guiado
    const estado = estadosUsuarios[from];
    if (estado && low === 'cancelar cita') {
      delete estadosUsuarios[from];
      const msg = '❌ Proceso cancelado. Envía *5* o escribe "agendar cita" para empezar de nuevo.';
      await sendWhatsAppMessage(from, msg, { log: true, phone: from });
      return res.sendStatus(200);
    }

    // ================== Flujo guiado en progreso
    if (estado) {
      if (estado.paso === 'esperandoNombre') {
        estado.datos.nombre = texto;
        estado.paso = 'esperandoFecha';
        const msg =
          `📅 Gracias, *${estado.datos.nombre}*.\n\n` +
          'Ahora indícame la *fecha y hora* en formato:\n⭐ 2025-11-15 15:00';
        await sendWhatsAppMessage(from, msg, { log: true, phone: from });
        return res.sendStatus(200);
      }

      if (estado.paso === 'esperandoFecha') {
        const [f, hRaw] = texto.split(' ');
        const fOK = /^\d{4}-\d{2}-\d{2}$/.test(f || '');
        const hOK = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(hRaw || '');
        if (!fOK || !hOK) {
          await sendWhatsAppMessage(
            from,
            '⚠️ Formato inválido. Usa *YYYY-MM-DD HH:mm* (ej.: 2025-11-15 15:00).',
            { log: true, phone: from }
          );
          return res.sendStatus(200);
        }
        const fechaHora = `${f} ${normalizarHora(hRaw)}`;
        if (!esHorarioLaboralEnFecha(fechaHora)) {
          await sendWhatsAppMessage(
            from,
            '⏰ Ese horario está *fuera de atención*.\nL-V: 8:00–12:30 y 14:00–18:00 · Sáb: 8:00–12:30.\n' +
              'Indícame otra *fecha y hora* dentro del horario. 😊',
            { log: true, phone: from }
          );
          return res.sendStatus(200);
        }
        estado.datos.fechaHora = fechaHora;
        estado.paso = 'esperandoTipo';
        await sendWhatsAppMessage(
          from,
          '📸 Perfecto. ¿Qué *tipo de sesión* deseas? (ej.: sesión familiar, fotos para título, etc.)',
          { log: true, phone: from }
        );
        return res.sendStatus(200);
      }

      if (estado.paso === 'esperandoTipo') {
        estado.datos.tipoSesion = texto;
        estado.paso = 'esperandoTelefono';
        await sendWhatsAppMessage(
          from,
          '📞 Genial. Por último, envíame tu *número de contacto* (ej.: 5037XXXXXX).',
          { log: true, phone: from }
        );
        return res.sendStatus(200);
      }

      if (estado.paso === 'esperandoTelefono') {
        estado.datos.telefono = texto || from;
        const { nombre, fechaHora, tipoSesion, telefono } = estado.datos;

        const ok = await crearCitaEnCalendar(fechaHora, tipoSesion, telefono, nombre);
        const msg = ok
          ? `✅ Cita creada.\n👤 *${nombre}*\n📅 *${fechaHora}*\n📸 *${tipoSesion}*\n📞 *${telefono}*`
          : '❌ No pude crear la cita. Revisa los datos o avisa a un colaborador.';
        await sendWhatsAppMessage(from, msg, { log: true, phone: from });
        delete estadosUsuarios[from];
        return res.sendStatus(200);
      }
    }

    // ================== Comandos / opciones
    const esComandoCita = low.startsWith('cita:'); // cita: YYYY-MM-DD HH:mm; tipo; tel
    const esComandoCancelar = low.startsWith('cancelar:');
    const esMisCitas = low === 'mis citas' || low.includes('ver mis citas');

    const esSaludo =
      low.includes('hola') ||
      low.includes('buenos dias') ||
      low.includes('buenos días') ||
      low.includes('buenas tardes') ||
      low.includes('buenas noches') ||
      low.includes('hey') ||
      low.includes('que tal') ||
      low.includes('qué tal');

    const esOpcion1 = low === '1' || low.includes('foto estudio') || low.includes('fotoestudio');
    const esOpcion2 =
      low === '2' ||
      low.includes('eventos sociales') ||
      low.includes('paquetes de eventos') ||
      low.includes('bodas') ||
      low.includes('bautizo') ||
      low.includes('15 años');
    const esOpcion3 =
      low === '3' ||
      low.includes('impresion fotografica') ||
      low.includes('impresión fotográfica') ||
      low.includes('imprimir fotos');
    const esOpcion4 = low === '4' || low.includes('consultar orden') || low.includes('estado de mi pedido');
    const esOpcion5 =
      low === '5' ||
      low.includes('agendar cita') ||
      low.includes('reservar cita') ||
      low.includes('reservar sesión') ||
      low.includes('reservar sesion');

    let replyText = '';

    if (esComandoCancelar) {
      const sin = texto.substring(9).trim();
      const [fechaHoraParte, telParte] = sin.split(';').map((s) => (s || '').trim());
      const [f, hRaw] = (fechaHoraParte || '').split(' ');
      const tel = telParte || from;
      const fOK = /^\d{4}-\d{2}-\d{2}$/.test(f || '');
      const hOK = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(hRaw || '');
      if (!fOK || !hOK) {
        replyText = '⚠️ Formato inválido. Usa: *cancelar: 2025-11-15 15:00; 50370000000*';
      } else {
        const fechaHora = `${f} ${normalizarHora(hRaw)}`;
        const ok = await cancelarCitaEnCalendar(fechaHora, tel);
        replyText = ok
          ? `✅ He cancelado la cita.\n📅 *${fechaHora}*\n📞 *${tel}*`
          : '❌ No encontré una cita con esa fecha/hora y teléfono.';
      }
    } else if (esMisCitas) {
      const citas = await listarCitasPorTelefono(from);
      replyText = citas.length
        ? '📅 *Tus próximas citas:*\n\n' +
          citas.map((c, i) => `${i + 1}. ${c.fecha} — ${c.resumen}`).join('\n')
        : '📅 No encontré citas próximas asociadas a tu número en los próximos 30 días.';
    } else if (esSaludo) {
      replyText =
        '👋 ¡Hola! Gracias por contactar con Arte Fotográfico 📸\nSoy un asistente virtual con IA.\n¿En qué puedo servirte hoy?\n\n' +
        'Elige una opción 👇\n' +
        '1️⃣ SERVICIO FOTO ESTUDIO\n' +
        '2️⃣ COTIZACIÓN DE PAQUETES DE EVENTOS SOCIALES\n' +
        '3️⃣ SERVICIO DE IMPRESIÓN FOTOGRÁFICA\n' +
        '4️⃣ CONSULTAR ORDEN\n' +
        '5️⃣ AGENDA TU CITA';
    } else if (esComandoCita) {
      const sin = texto.substring(5).trim();
      const partes = sin.split(';').map((p) => p.trim());
      const [f, hRaw] = (partes[0] || '').split(' ');
      const tipo = partes[1] || 'fotográfica';
      const tel = partes[2] || from;
      const fOK = /^\d{4}-\d{2}-\d{2}$/.test(f || '');
      const hOK = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(hRaw || '');
      if (!fOK || !hOK) {
        replyText =
          '⚠️ Formato inválido.\nUsa: *cita: 2025-11-15 15:00; sesión familiar; 50370000000*';
      } else {
        const fechaHora = `${f} ${normalizarHora(hRaw)}`;
        if (!esHorarioLaboralEnFecha(fechaHora)) {
          replyText =
            '⏰ Ese horario está fuera de atención.\nL-V: 8:00–12:30 y 14:00–18:00 · Sáb: 8:00–12:30.\n' +
            'Elige otra fecha/hora dentro del horario. 😊';
        } else {
          const ok = await crearCitaEnCalendar(fechaHora, tipo, tel, null);
          replyText = ok
            ? `✅ Cita creada.\n📅 *${fechaHora}*\n📸 *${tipo}*\n📞 *${tel}*`
            : '❌ Hubo un problema al crear la cita. Intenta de nuevo.';
        }
      }
    } else if (esOpcion1) {
      replyText =
        '📷 *SERVICIO FOTO ESTUDIO*\n\n' +
        '🔸 *Títulos y documentos* (Bachiller, 7x9 USO, 6x8 UMA, certificados, escalafón, carnets…)\n' +
        '🔸 *Servicios migratorios* (VISA USA 2x2, Canadá 3.5x4.5, México 3.2x2.6)\n' +
        '🔸 *Sesiones fotográficas* (personales, pareja, familiares, bebés, portafolio, graduados, navideñas…)\n\n' +
        '¿Sobre qué servicio te gustaría más información?';
    } else if (esOpcion2) {
      replyText =
        '💍 *PAQUETES DE EVENTOS SOCIALES*\n\n' +
        'Bodas, 15 años, bautizos, comuniones, baby showers, infantiles, pre-15 y exteriores.\n' +
        'Cuéntame *tipo de evento, fecha y lugar* para cotizar (precios personalizados). ' +
        'Si lo prefieres, puedo comunicarte con un asesor.';
    } else if (esOpcion3) {
      replyText =
        '🖨️ *IMPRESIÓN FOTOGRÁFICA*\n\n' +
        'Tenemos línea aficionado y profesional. ¿Qué tamaño deseas imprimir?';
    } else if (esOpcion4) {
      replyText =
        '📦 *CONSULTAR ORDEN*\n\n' +
        'Envíame tu *número de orden* o *nombre completo* y consultaré con el personal.';
    } else if (esOpcion5) {
      estadosUsuarios[from] = { paso: 'esperandoNombre', datos: {} };
      replyText =
        '🗓️ *Agendar cita*\n\n' +
        'Perfecto, te ayudo a reservar.\n1️⃣ Primero, dime tu *nombre completo*.\n\n' +
        'Puedes escribir *cancelar cita* para terminar el proceso.';
    } else {
      // Catálogo → IA
      const hit = buscarEnCatalogo(texto);
      if (hit) {
        replyText = formatearRespuestaCatalogo(hit);
      } else {
        const ia = await askOpenAI(
          `Cliente pregunta: "${texto}". Responde como asistente del estudio Arte Fotográfico (Sonsonate). ` +
            `Si la pregunta es sobre precios/vestimenta/impresión y no hay datos exactos, responde útilmente y sugiere visitarnos.`
        );
        replyText =
          ia ||
          'Gracias por tu mensaje. ¿Podrías darme un poco más de detalle para ayudarte mejor?';
      }
    }

    if (replyText) {
      await sendWhatsAppMessage(from, replyText, { log: true, phone: from });
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('⚠️ Error webhook:', e);
    res.sendStatus(200);
  }
});

app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
