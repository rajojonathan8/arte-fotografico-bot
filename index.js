require('dotenv').config();

const { google } = require('googleapis');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

/* ================== ENV / CONFIG ================== */
const WHATSAPP_TOKEN        = process.env.WHATSAPP_TOKEN;
const GEMINI_API_KEY        = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY        = process.env.OPENAI_API_KEY; // opcional
const GOOGLE_SERVICE_ACCOUNT= process.env.GOOGLE_SERVICE_ACCOUNT;
const GOOGLE_CALENDAR_ID    = process.env.GOOGLE_CALENDAR_ID;

const VERIFY_TOKEN   = 'MI_TOKEN_SECRETO_ARTE_FOTOGRAFICO'; // igual al de Meta
const PHONE_NUMBER_ID= '805856909285040';

// estado por usuario para flujo guiado
// estadosUsuarios[telefono] = { paso: 'esperandoNombre'|'esperandoFecha'|'esperandoTipo'|'esperandoTelefono', datos:{...}}
const estadosUsuarios = {};

/* ================== GOOGLE CALENDAR ================== */
let serviceAccount = null;
if (GOOGLE_SERVICE_ACCOUNT) {
  try { serviceAccount = JSON.parse(GOOGLE_SERVICE_ACCOUNT); }
  catch (e) { console.error('❌ Error al parsear GOOGLE_SERVICE_ACCOUNT:', e.message); }
}

async function getCalendarClient() {
  if (!serviceAccount || !serviceAccount.client_email || !serviceAccount.private_key) {
    console.error('⚠️ Falta serviceAccount (client_email/private_key)');
    return null;
  }
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  const authClient = await auth.getClient();
  return google.calendar({ version: 'v3', auth: authClient });
}

async function crearEventoDePruebaCalendar(nombreCliente, telefono) {
  try {
    const calendar = await getCalendarClient();
    if (!calendar || !GOOGLE_CALENDAR_ID) return false;

    const ahora   = new Date();
    const inicio  = new Date(ahora.getTime() + 60 * 60 * 1000);
    const fin     = new Date(inicio.getTime() + 30 * 60 * 1000);

    const evento = {
      summary: `Cita de prueba con ${nombreCliente || 'cliente de WhatsApp'}`,
      description: `Cita creada automáticamente desde el bot de Arte Fotográfico.\nTeléfono: ${telefono || ''}`,
      start: { dateTime: inicio.toISOString(), timeZone: 'America/El_Salvador' },
      end:   { dateTime: fin.toISOString(),    timeZone: 'America/El_Salvador' },
    };

    const res = await calendar.events.insert({ calendarId: GOOGLE_CALENDAR_ID, requestBody: evento });
    console.log('✅ Evento de prueba creado en Calendar:', res.data.id);
    return true;
  } catch (error) {
    console.error('❌ Error al crear evento de prueba:', error.response?.data || error.message);
    return false;
  }
}

/* ====== Helper: normalizar "YYYY-M-D H:mm" → "YYYY-MM-DD HH:mm" ====== */
function normalizarFechaHora(texto) {
  const m = texto.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  let anio   = parseInt(m[1], 10);
  let mes    = parseInt(m[2], 10);
  let dia    = parseInt(m[3], 10);
  let hora   = parseInt(m[4], 10);
  let minuto = parseInt(m[5], 10);
  if (mes < 1 || mes > 12) return null;
  if (dia < 1 || dia > 31) return null;
  if (hora < 0 || hora > 23) return null;
  if (minuto < 0 || minuto > 59) return null;
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${anio}-${pad2(mes)}-${pad2(dia)} ${pad2(hora)}:${pad2(minuto)}`;
}

/* ====== Crear Cita ====== */
async function crearCitaEnCalendar(fechaHoraTexto, tipoSesion, telefono, nombreCliente) {
  try {
    const calendar = await getCalendarClient();
    if (!calendar || !GOOGLE_CALENDAR_ID) return false;

    const [fechaStr, horaStr] = fechaHoraTexto.split(' ');
    const [anio, mes, dia]    = fechaStr.split('-').map(Number);
    const [hora, minuto]      = horaStr.split(':').map(Number);
    const pad2 = (n) => String(n).padStart(2, '0');

    const inicioLocal = `${anio}-${pad2(mes)}-${pad2(dia)}T${pad2(hora)}:${pad2(minuto)}:00`;
    const totalMinutosInicio = hora * 60 + minuto + 60; // +1h
    const horaFin    = Math.floor(totalMinutosInicio / 60);
    const minutoFin  = totalMinutosInicio % 60;
    const finLocal   = `${anio}-${pad2(mes)}-${pad2(dia)}T${pad2(horaFin)}:${pad2(minutoFin)}:00`;

    const evento = {
      summary: `Sesión ${tipoSesion || 'fotográfica'} - ${nombreCliente || 'Cliente WhatsApp'}`,
      description:
        `Sesión agendada desde el bot de Arte Fotográfico.\n` +
        (nombreCliente ? `Nombre del cliente: ${nombreCliente}\n` : '') +
        `Teléfono: ${telefono || ''}`,
      start: { dateTime: inicioLocal, timeZone: 'America/El_Salvador' },
      end:   { dateTime: finLocal,    timeZone: 'America/El_Salvador' },
    };

    const res = await calendar.events.insert({ calendarId: GOOGLE_CALENDAR_ID, requestBody: evento });
    console.log('✅ Cita creada en Calendar:', res.data.id);
    return true;
  } catch (error) {
    console.error('❌ Error al crear cita:', error.response?.data || error.message);
    return false;
  }
}

/* ====== Helpers de fecha/hora ====== */
function formatearFechaHoraLocal(dateObj) {
  const opciones = {
    timeZone: 'America/El_Salvador',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  };
  const partes = new Intl.DateTimeFormat('en-CA', opciones).formatToParts(dateObj);
  let year, month, day, hour, minute;
  for (const p of partes) {
    if (p.type === 'year')   year = p.value;
    if (p.type === 'month')  month = p.value;
    if (p.type === 'day')    day = p.value;
    if (p.type === 'hour')   hour = p.value;
    if (p.type === 'minute') minute = p.value;
  }
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

/* ====== Cancelar Cita ====== */
async function cancelarCitaEnCalendar(fechaHoraTexto, telefono) {
  try {
    const calendar = await getCalendarClient();
    if (!calendar || !GOOGLE_CALENDAR_ID) return false;

    const [fechaStr, horaStr] = fechaHoraTexto.split(' ');
    const [anio, mes, dia]    = fechaStr.split('-').map(Number);
    const [hora, minuto]      = horaStr.split(':').map(Number);

    const inicioDiaLocal = new Date(anio, mes - 1, dia, 0, 0, 0);
    const finDiaLocal    = new Date(anio, mes - 1, dia, 23, 59, 59);

    const listRes = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: inicioDiaLocal.toISOString(),
      timeMax: finDiaLocal.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const items = listRes.data.items || [];
    const telefonoLimpio = telefono.replace(/[^0-9]/g, '');
    const ultimos4 = telefonoLimpio.slice(-4);

    for (const ev of items) {
      const desc = (ev.description || '').toLowerCase();
      const resumen = (ev.summary || '').toLowerCase();

      let fechaEventoTexto = '';
      if (ev.start?.dateTime) {
        const fechaEv = new Date(ev.start.dateTime);
        fechaEventoTexto = formatearFechaHoraLocal(fechaEv);
      }
      if (fechaEventoTexto !== fechaHoraTexto) continue;

      const coincideTelefono =
        desc.includes(telefonoLimpio) ||
        resumen.includes(telefonoLimpio) ||
        (ultimos4 && desc.includes(ultimos4));

      if (coincideTelefono) {
        await calendar.events.delete({ calendarId: GOOGLE_CALENDAR_ID, eventId: ev.id });
        console.log('✅ Cita eliminada:', ev.id);
        return true;
      }
    }
    console.log('❌ No se encontró evento coincidente.');
    return false;
  } catch (error) {
    console.error('❌ Error al cancelar cita:', error.response?.data || error.message);
    return false;
  }
}

/* ====== Listar citas por teléfono (mis citas) ====== */
async function listarCitasPorTelefono(telefono) {
  try {
    const calendar = await getCalendarClient();
    if (!calendar || !GOOGLE_CALENDAR_ID) return [];

    const ahora = new Date();
    const dentroDe30Dias = new Date(ahora.getTime() + 30 * 24 * 60 * 60 * 1000);

    const listRes = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: ahora.toISOString(),
      timeMax: dentroDe30Dias.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const items = listRes.data.items || [];
    const telefonoLimpio = telefono.replace(/[^0-9]/g, '');
    const ultimos4 = telefonoLimpio.slice(-4);

    const resultados = [];
    for (const ev of items) {
      const desc = (ev.description || '').toLowerCase();
      const resumen = (ev.summary || '').toLowerCase();

      const coincideTelefono =
        desc.includes(telefonoLimpio) ||
        resumen.includes(telefonoLimpio) ||
        (ultimos4 && desc.includes(ultimos4));

      if (!coincideTelefono) continue;

      let fechaTexto = '';
      if (ev.start?.dateTime) fechaTexto = formatearFechaHoraLocal(new Date(ev.start.dateTime));

      resultados.push({ fecha: fechaTexto, resumen: ev.summary || 'Cita sin título' });
    }
    return resultados;
  } catch (error) {
    console.error('❌ Error al listar citas:', error.response?.data || error.message);
    return [];
  }
}

/* ================== HORARIOS ================== */
function esHorarioLaboral() {
  const ahora = new Date();
  const fechaLocal = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/El_Salvador' }));
  const dia = fechaLocal.getDay();  // 0 domingo, 6 sábado
  const hora = fechaLocal.getHours();
  const minuto = fechaLocal.getMinutes();
  const horaDecimal = hora + minuto / 60;

  if (dia >= 1 && dia <= 5) return (horaDecimal >= 8 && horaDecimal <= 12.5) || (horaDecimal >= 14 && horaDecimal <= 18);
  if (dia === 6)             return (horaDecimal >= 8 && horaDecimal <= 12.5);
  return false; // domingo
}
function esDomingo() {
  const ahora = new Date();
  const fechaLocal = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/El_Salvador' }));
  return fechaLocal.getDay() === 0;
}
// Verifica una fecha/hora específica (texto) dentro del horario laboral
function esHorarioLaboralEnFecha(fechaHoraTexto) {
  const partes = fechaHoraTexto.split(' ');
  if (partes.length !== 2) return false;
  const [fechaStr, horaStr] = partes;
  const [anio, mes, dia] = fechaStr.split('-').map(Number);
  const [hora, minuto]   = horaStr.split(':').map(Number);
  if ([anio,mes,dia,hora,minuto].some(isNaN)) return false;

  const fecha = new Date(anio, mes - 1, dia, hora, minuto);
  const diaSemana = fecha.getDay();
  const horaDecimal = hora + minuto / 60;

  if (diaSemana >= 1 && diaSemana <= 5) return (horaDecimal >= 8 && horaDecimal <= 12.5) || (horaDecimal >= 14 && horaDecimal <= 18);
  if (diaSemana === 6)                   return (horaDecimal >= 8 && horaDecimal <= 12.5);
  return false;
}

/* ================== IA: GEMINI ================== */
async function preguntarAGemini(mensajeUsuario) {
  if (!GEMINI_API_KEY) return 'Por ahora no puedo usar IA, pero con gusto te atiendo como asistente. 😊';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY;
  try {
    const r = await axios.post(url, {
      contents: [{ parts: [{ text:
        'Eres el Asistente Arte Fotográfico. Tono amable, profesional y breve. ' +
        'Ubicación: Sonsonate, El Salvador. Responde siempre en español.\n\n' +
        'Mensaje: ' + mensajeUsuario
      }]}]
    });
    const t = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return t ? t.trim() : 'La IA no pudo responder ahora.';
  } catch (e) {
    console.error('❌ Error Gemini:', e.response?.data || e.message);
    return 'Tuvimos un problema con la IA. Intenta más tarde.';
  }
}

/* ================== WHATSAPP ================== */
app.use(bodyParser.json());

app.get('/', (_req, res) => res.send('Servidor Arte Fotográfico activo 🚀'));

// Verificación webhook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const tokenVerify = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && tokenVerify && mode === 'subscribe' && tokenVerify === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Verificación fallida');
    res.sendStatus(403);
  }
});

// Enviar mensaje
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  try {
    const r = await axios.post(url, {
      messaging_product: 'whatsapp',
      to, text: { body: text }
    }, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
    console.log('✅ WhatsApp OK:', r.data);
  } catch (e) {
    console.error('❌ Error enviando WhatsApp:', e.response?.data || e.message);
  }
}

// Webhook de mensajes
app.post('/webhook', async (req, res) => {
  console.log('📩 Webhook recibido');
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const texto = (message.text?.body || '').trim();
    const textoLower = texto.toLowerCase();

    // Fuera de horario (según hora actual)
    if (!esHorarioLaboral()) {
      const msg = esDomingo()
        ? '📸 *¡Gracias por contactarnos con Arte Fotográfico!* 💬\n\n' +
          'Hoy es *domingo* y nuestro estudio se encuentra *cerrado* por descanso del personal. 🛌\n\n' +
          '🕓 *Horario:*\n👉 *Lunes a viernes:* 8:00–12:30 y 14:00–18:00\n👉 *Sábados:* 8:00–12:30\n\n' +
          'Puedes dejar tu mensaje y el lunes te respondemos 😊'
        : '📸 *¡Gracias por contactarnos con Arte Fotográfico!* 💬\n\n' +
          'En este momento estamos *fuera de horario*, y te responderemos cuando volvamos. 😊\n\n' +
          '🕓 *Horario:*\n👉 *Lunes a viernes:* 8:00–12:30 y 14:00–18:00\n👉 *Sábados:* 8:00–12:30\n📍 Sonsonate, El Salvador.';
      await sendWhatsAppMessage(from, msg);
      return res.sendStatus(200);
    }

    /* ====== Flujo guiado activo ====== */
    const estado = estadosUsuarios[from];
    if (estado && textoLower === 'cancelar cita') {
      delete estadosUsuarios[from];
      await sendWhatsAppMessage(from, '❌ He cancelado el proceso de agendar cita. Envía *5* o escribe "agendar cita" para empezar de nuevo.');
      return res.sendStatus(200);
    }

    if (estado) {
      if (estado.paso === 'esperandoNombre') {
        estado.datos.nombre = texto;
        estado.paso = 'esperandoFecha';
        await sendWhatsAppMessage(from,
          `📅 Perfecto, *${estado.datos.nombre}*.\n\n` +
          'Ahora indícame la *fecha y hora* en el formato:\n⭐ 2025-11-15 15:00\n\n' +
          'Ej.: 2025-11-15 15:00 (15 de noviembre de 2025 a las 3:00 p.m.).\n' +
          'Si deseas cancelar este proceso escribe "cancelar cita".'
        );
        return res.sendStatus(200);
      }

      if (estado.paso === 'esperandoFecha') {
        const canon = normalizarFechaHora(texto);
        if (!canon) {
          await sendWhatsAppMessage(from,
            '⚠️ El formato de fecha y hora no es válido.\nUsa: *2025-11-15 15:00* (año-mes-día hora:minuto).'
          );
          return res.sendStatus(200);
        }
        if (!esHorarioLaboralEnFecha(canon)) {
          await sendWhatsAppMessage(from,
            '⏰ El horario indicado está *fuera de atención*.\n\n' +
            '🕓 *Horario:*\n👉 *Lunes a viernes:* 8:00–12:30 y 14:00–18:00\n👉 *Sábados:* 8:00–12:30\n\n' +
            'Por favor comparte otra *fecha y hora* dentro del horario. 😊'
          );
          return res.sendStatus(200);
        }
        estado.datos.fechaHora = canon;
        estado.paso = 'esperandoTipo';
        await sendWhatsAppMessage(from, '📸 Perfecto. Ahora dime el *tipo de sesión* (familiar, título, pareja, etc.).');
        return res.sendStatus(200);
      }

      if (estado.paso === 'esperandoTipo') {
        estado.datos.tipoSesion = texto;
        estado.paso = 'esperandoTelefono';
        await sendWhatsAppMessage(from, '📞 Genial. Por último, envíame tu *número de contacto* (ej.: 5037XXXXXX).');
        return res.sendStatus(200);
      }

      if (estado.paso === 'esperandoTelefono') {
        estado.datos.telefono = texto || from;
        const { nombre, fechaHora, tipoSesion, telefono } = estado.datos;

        const ok = await crearCitaEnCalendar(fechaHora, tipoSesion, telefono, nombre);
        if (ok) {
          await sendWhatsAppMessage(from,
            '✅ He creado tu cita en el calendario de Arte Fotográfico.\n' +
            `👤 Nombre: *${nombre}*\n` +
            `📅 Fecha y hora: *${fechaHora}*\n` +
            `📸 Tipo de sesión: *${tipoSesion}*\n` +
            `📞 Contacto: *${telefono}*`
          );
        } else {
          await sendWhatsAppMessage(from,
            '❌ Hubo un problema al crear la cita. Revisa los datos y vuelve a intentarlo o avisa a un colaborador.'
          );
        }
        delete estadosUsuarios[from];
        return res.sendStatus(200);
      }
    }

    /* ====== Detección de opciones/comandos ====== */
    const esTestCalendar   = textoLower === 'test calendar';
    const esComandoCita    = textoLower.startsWith('cita:');
    const esComandoCancelar= textoLower.startsWith('cancelar:');
    const esMisCitas       = textoLower === 'mis citas' || textoLower.includes('ver mis citas') || textoLower.includes('mis próximas citas');

    const esSaludo =
      textoLower.includes('hola') || textoLower.includes('buenos dias') || textoLower.includes('buenos días') ||
      textoLower.includes('buenas tardes') || textoLower.includes('buenas noches') ||
      textoLower.includes('hey') || textoLower.includes('qué tal') || textoLower.includes('que tal');

    const usaIAForzado = textoLower.startsWith('ia:');

    const esOpcion1 = textoLower === '1' || textoLower.includes('foto estudio') || textoLower.includes('fotoestudio') || textoLower.includes('estudio de fotos');
    const esOpcion2 = textoLower === '2' || textoLower.includes('eventos sociales') || textoLower.includes('paquetes de eventos') || textoLower.includes('bodas') || textoLower.includes('15 años') || textoLower.includes('quince años') || textoLower.includes('bautizo') || textoLower.includes('bautizos');
    const esOpcion3 = textoLower === '3' || textoLower.includes('impresión fotográfica') || textoLower.includes('impresion fotografica') || textoLower.includes('imprimir fotos') || textoLower.includes('impresiones de fotos');
    const esOpcion4 = textoLower === '4' || textoLower.includes('consultar orden') || textoLower.includes('estado de mi pedido') || textoLower.includes('rastrear pedido') || textoLower.includes('ver mi pedido');
    const esOpcion5 = textoLower === '5' || textoLower.includes('agendar cita') || textoLower.includes('agenda tu cita') || textoLower.includes('reservar cita') || textoLower.includes('hacer una cita') || textoLower.includes('reservar sesión') || textoLower.includes('reservar sesion');

    let replyText = '';

    if (usaIAForzado) {
      const pregunta = texto.substring(3).trim() || 'Responde como asistente de Arte Fotográfico.';
      replyText = await preguntarAGemini(pregunta);

    } else if (esComandoCancelar) {
      // cancelar: YYYY-MM-DD HH:mm; telefono
      const sinPrefijo = texto.substring(9).trim();
      const partes = sinPrefijo.split(';').map(p => p.trim());
      const canon = normalizarFechaHora(partes[0]);
      const telefonoCliente = partes[1] || from;

      if (!canon) {
        replyText = '⚠️ Formato de cancelación inválido.\nUsa: *cancelar: 2025-11-15 15:00; 50370000000*';
      } else {
        const ok = await cancelarCitaEnCalendar(canon, telefonoCliente);
        replyText = ok
          ? `✅ He cancelado la cita.\n📅 *${canon}*\n📞 *${telefonoCliente}*`
          : '❌ No encontré una cita que coincida con esa fecha/hora y teléfono.';
      }

    } else if (esMisCitas) {
      const citas = await listarCitasPorTelefono(from);
      replyText = !citas.length
        ? '📅 No encontré citas próximas asociadas a tu número en los próximos 30 días.'
        : '📅 *Estas son tus próximas citas:*\n\n' + citas.map((c,i)=>`${i+1}. ${c.fecha} — ${c.resumen}`).join('\n');

    } else if (esSaludo) {
      replyText =
        '👋 ¡Hola! Gracias por contactar con Arte Fotográfico 📸\n' +
        'Soy un asistente virtual con inteligencia artificial.\n' +
        '¿En qué puedo servirte hoy?\n\n' +
        '1️⃣ SERVICIO FOTO ESTUDIO\n' +
        '2️⃣ COTIZACIÓN DE PAQUETES DE EVENTOS SOCIALES\n' +
        '3️⃣ SERVICIO DE IMPRESIÓN FOTOGRÁFICA\n' +
        '4️⃣ CONSULTAR ORDEN\n' +
        '5️⃣ AGENDA TU CITA';

    } else if (esComandoCita) {
      // cita: YYYY-MM-DD HH:mm; tipo; telefono
      const sinPrefijo = texto.substring(5).trim();
      const partes = sinPrefijo.split(';').map(p => p.trim());

      const canon = normalizarFechaHora(partes[0]);
      const tipoSesion = partes[1] || 'fotográfica';
      const telefonoCliente = partes[2] || from;

      if (!canon) {
        replyText = '⚠️ Formato de cita inválido.\nUsa: *cita: 2025-11-15 15:00; sesión familiar; 50370000000*';
      } else if (!esHorarioLaboralEnFecha(canon)) {
        replyText =
          '⏰ El horario indicado está *fuera de atención*.\n\n' +
          '🕓 *Horario:*\n👉 *Lunes a viernes:* 8:00–12:30 y 14:00–18:00\n👉 *Sábados:* 8:00–12:30';
      } else {
        const ok = await crearCitaEnCalendar(canon, tipoSesion, telefonoCliente, null);
        replyText = ok
          ? `✅ He creado tu cita.\n📅 *${canon}*\n📸 *${tipoSesion}*\n📞 *${telefonoCliente}*`
          : '❌ Ocurrió un problema al crear la cita. Intenta de nuevo o avisa a un colaborador.';
      }

    } else if (esTestCalendar) {
      const ok = await crearEventoDePruebaCalendar('Cliente de prueba', from);
      replyText = ok
        ? '✅ Creé un *evento de prueba* para dentro de 1 hora. Revisa tu Google Calendar 🗓️'
        : '❌ No pude crear el evento de prueba. Revisa credenciales.';

    } else if (esOpcion1) {
      replyText =
        '📷 *SERVICIO FOTO ESTUDIO*\n\n' +
        '🔸 Títulos y documentos (Bachiller, Univ. 7x9 y 6x8, certificados, carnets…)\n' +
        '🔸 Migratorios: VISA USA 2x2, Canadá 3.5x4.5, México 3.2x2.6 (incluye 4 fotos, $10.00)\n' +
        '🔸 Sesiones: personales, pareja, familiar, bebés, graduados, navideñas, portafolio…\n' +
        '🔸 Retratos: B/N, contemporáneo y artístico.\n' +
        '¿Te ayudo a agendar?';

    } else if (esOpcion2) {
      replyText =
        '💍 *PAQUETES DE EVENTOS SOCIALES*\nBodas, 15 años, bautizos, comuniones, baby showers, infantiles, pre–15 y exteriores.\n\n' +
        'Para cotizar: tipo de evento, fecha y lugar. Puedo comunicarte con nuestro personal.';

    } else if (esOpcion3) {
      replyText =
        '🖨️ *IMPRESIÓN FOTOGRÁFICA*\nAlta calidad en varios tamaños y acabados.\nEnvíanos tus fotos por USB, WhatsApp o correo.\n¿Deseas que te asesore un colaborador?';

    } else if (esOpcion4) {
      replyText =
        '📦 *CONSULTAR ORDEN*\nEnvíame: número de orden o nombre completo con el que hiciste el pedido, y lo revisamos.';

    } else if (esOpcion5) {
      estadosUsuarios[from] = { paso: 'esperandoNombre', datos: {} };
      replyText =
        '🗓️ *Agendar cita en Arte Fotográfico*\n\n' +
        'Perfecto, te ayudo a reservar tu sesión.\n\n' +
        '1️⃣ Para empezar, dime por favor tu *nombre completo*.\n\n' +
        'Si deseas cancelar este proceso escribe "cancelar cita".';

    } else {
      // fallback IA
      const prompt =
        `Cliente dice: "${texto}". Responde como asistente de Arte Fotográfico (Sonsonate). ` +
        `Sé amable, profesional y breve (máx. 3 líneas). Si pregunta por horarios/dirección/servicios, respóndelo claro.`;
      replyText = await preguntarAGemini(prompt);
    }

    if (replyText) await sendWhatsAppMessage(from, replyText);
  } catch (err) {
    console.error('⚠️ Error procesando webhook:', err);
  }
  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
