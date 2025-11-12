require('dotenv').config();

const { google } = require('googleapis');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Vars de entorno
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

// ===== Config fijos
const VERIFY_TOKEN = 'MI_TOKEN_SECRETO_ARTE_FOTOGRAFICO';
const PHONE_NUMBER_ID = '805856909285040';

// ===== Estado por usuario (flujo guiado de citas)
const estadosUsuarios = {}; // { [telefono]: { paso, datos: { nombre, fechaHora, tipoSesion, telefono } } }

// ================= GOOGLE CALENDAR =================
let serviceAccount = null;
if (GOOGLE_SERVICE_ACCOUNT) {
  try { serviceAccount = JSON.parse(GOOGLE_SERVICE_ACCOUNT); }
  catch (e) { console.error('❌ GOOGLE_SERVICE_ACCOUNT inválido:', e.message); }
}

async function getCalendarClient() {
  if (!serviceAccount?.client_email || !serviceAccount?.private_key) {
    console.error('⚠️ Faltan credenciales de service account');
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

    const ahora = new Date();
    const inicio = new Date(ahora.getTime() + 60 * 60 * 1000);
    const fin = new Date(inicio.getTime() + 30 * 60 * 1000);

    const evento = {
      summary: `Cita de prueba con ${nombreCliente || 'cliente de WhatsApp'}`,
      description: `Creado por el bot.\nTeléfono: ${telefono || ''}`,
      start: { dateTime: inicio.toISOString(), timeZone: 'America/El_Salvador' },
      end: { dateTime: fin.toISOString(), timeZone: 'America/El_Salvador' },
    };

    await calendar.events.insert({ calendarId: GOOGLE_CALENDAR_ID, requestBody: evento });
    return true;
  } catch (e) {
    console.error('❌ crearEventoDePruebaCalendar:', e.response?.data || e.message);
    return false;
  }
}

async function crearCitaEnCalendar(fechaHoraTexto, tipoSesion, telefono, nombreCliente) {
  try {
    const calendar = await getCalendarClient();
    if (!calendar || !GOOGLE_CALENDAR_ID) return false;

    const [fechaStr, horaStr] = fechaHoraTexto.split(' ');
    const [anio, mes, dia] = fechaStr.split('-').map(Number);
    const [hora, minuto] = horaStr.split(':').map(Number);
    const pad2 = n => String(n).padStart(2, '0');

    const inicioLocal = `${anio}-${pad2(mes)}-${pad2(dia)}T${pad2(hora)}:${pad2(minuto)}:00`;
    const totalMinutos = hora * 60 + minuto + 60; // 1h
    const hFin = Math.floor(totalMinutos / 60);
    const mFin = totalMinutos % 60;
    const finLocal = `${anio}-${pad2(mes)}-${pad2(dia)}T${pad2(hFin)}:${pad2(mFin)}:00`;

    const evento = {
      summary: `Sesión ${tipoSesion || 'fotográfica'} - ${nombreCliente || 'Cliente WhatsApp'}`,
      description:
        `Sesión agendada desde el bot de Arte Fotográfico.\n` +
        (nombreCliente ? `Nombre: ${nombreCliente}\n` : '') +
        `Teléfono: ${telefono || ''}`,
      start: { dateTime: inicioLocal, timeZone: 'America/El_Salvador' },
      end: { dateTime: finLocal, timeZone: 'America/El_Salvador' },
    };

    await calendar.events.insert({ calendarId: GOOGLE_CALENDAR_ID, requestBody: evento });
    return true;
  } catch (e) {
    console.error('❌ crearCitaEnCalendar:', e.response?.data || e.message);
    return false;
  }
}

function formatearFechaHoraLocal(dateObj) {
  const opt = { timeZone: 'America/El_Salvador', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
  const parts = new Intl.DateTimeFormat('en-CA', opt).formatToParts(dateObj);
  const grab = t => parts.find(p => p.type === t)?.value;
  return `${grab('year')}-${grab('month')}-${grab('day')} ${grab('hour')}:${grab('minute')}`;
}

async function cancelarCitaEnCalendar(fechaHoraTexto, telefono) {
  try {
    const calendar = await getCalendarClient();
    if (!calendar || !GOOGLE_CALENDAR_ID) return false;

    const [fechaStr, horaStr] = fechaHoraTexto.split(' ');
    const [y, m, d] = fechaStr.split('-').map(Number);
    const inicioDia = new Date(y, m - 1, d, 0, 0, 0).toISOString();
    const finDia = new Date(y, m - 1, d, 23, 59, 59).toISOString();

    const resp = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: inicioDia,
      timeMax: finDia,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const tel = telefono.replace(/[^0-9]/g, '');
    const ult4 = tel.slice(-4);

    for (const ev of resp.data.items || []) {
      const desc = (ev.description || '').toLowerCase();
      const sum = (ev.summary || '').toLowerCase();
      const fechaTxt = ev.start?.dateTime ? formatearFechaHoraLocal(new Date(ev.start.dateTime)) : '';

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

    const tel = telefono.replace(/[^0-9]/g, '');
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

// ================= HORARIO =================
function esHorarioLaboralActual() {
  const ahora = new Date();
  const loc = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/El_Salvador' }));
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
  const [fechaStr, horaStrRaw] = (fechaHoraTexto || '').split(' ');
  if (!fechaStr || !horaStrRaw) return false;

  // aceptar H:mm o HH:mm
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr)) return false;
  if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(horaStrRaw)) return false;

  let [h, m] = horaStrRaw.split(':').map(Number);
  const d = new Date(
    ...fechaStr.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))),
    h, m
  );
  const dow = d.getDay();
  const hd = h + m / 60;
  if (dow >= 1 && dow <= 5) return (hd >= 8 && hd <= 12.5) || (hd >= 14 && hd <= 18);
  if (dow === 6) return hd >= 8 && hd <= 12.5;
  return false;
}
function normalizarHora(horaStrRaw) {
  let [h, m] = horaStrRaw.split(':').map(Number);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// ================= IA (Gemini) =================
async function preguntarAGemini(mensaje) {
  if (!GEMINI_API_KEY) {
    console.error('⚠️ Falta GEMINI_API_KEY');
    return 'Por ahora no puedo usar IA gratuita, pero con gusto te ayudo como asistente básico 😊';
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  try {
    const r = await axios.post(url, {
      contents: [{ parts: [{ text:
        'Eres el Asistente Arte Fotográfico. Responde en español, amable, claro y breve.\n' +
        'Negocio en Sonsonate, El Salvador.\n\n' +
        `Mensaje del cliente: ${mensaje}`
      }]}],
    });
    const txt = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return txt?.trim() || 'No pude generar una respuesta en este momento.';
  } catch (e) {
    console.error('❌ Gemini:', e.response?.data || e.message);
    return 'Ocurrió un problema al usar la IA gratuita (Gemini). Intenta de nuevo más tarde.';
  }
}

// ================= WHATSAPP =================
app.use(bodyParser.json());

app.get('/', (_, res) => res.send('Servidor Arte Fotográfico activo 🚀'));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const tokenVerify = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && tokenVerify === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    res.status(200).send(challenge);
  } else res.sendStatus(403);
});

async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(url, {
      messaging_product: 'whatsapp',
      to, text: { body: text }
    }, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
  } catch (e) {
    console.error('❌ Error enviando WhatsApp:', e.response?.data || e.message);
  }
}

app.post('/webhook', async (req, res) => {
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const texto = (message.text?.body || '').trim();
    const low = texto.toLowerCase();

    // Fuera de horario (según hora ACTUAL)
    if (!esHorarioLaboralActual()) {
      const out = esDomingo()
        ? '📸 *Gracias por contactarnos con Arte Fotográfico.*\n\nHoy es *domingo* y estamos *cerrados* por descanso del personal.\n\n🕓 *Horario:*\nL-V: 8:00–12:30 y 14:00–18:00\nSáb: 8:00–12:30\n\nDéjanos tu mensaje y te respondemos al abrir. 😊'
        : '📸 *Gracias por contactarnos con Arte Fotográfico.*\n\nAhora estamos *fuera de horario*, te responderemos en cuanto estemos de vuelta. 😊\n\n🕓 *Horario:*\nL-V: 8:00–12:30 y 14:00–18:00\nSáb: 8:00–12:30';
      await sendWhatsAppMessage(from, out);
      return res.sendStatus(200);
    }

    // ===== Cancelar flujo guiado
    const estado = estadosUsuarios[from];
    if (estado && low === 'cancelar cita') {
      delete estadosUsuarios[from];
      await sendWhatsAppMessage(from, '❌ Proceso cancelado. Envía *5* o escribe "agendar cita" para empezar de nuevo.');
      return res.sendStatus(200);
    }

    // ===== Flujo guiado en progreso
    if (estado) {
      if (estado.paso === 'esperandoNombre') {
        estado.datos.nombre = texto;
        estado.paso = 'esperandoFecha';
        await sendWhatsAppMessage(
          from,
          `📅 Gracias, *${estado.datos.nombre}*.\n\nAhora indícame la *fecha y hora* en formato:\n⭐ 2025-11-15 15:00\n(Ej.: 2025-11-15 15:00).`
        );
        return res.sendStatus(200);
      }

      if (estado.paso === 'esperandoFecha') {
        const [fechaStr, horaStrRaw] = texto.split(' ');
        const fechaOK = /^\d{4}-\d{2}-\d{2}$/.test(fechaStr || '');
        const horaOK = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(horaStrRaw || '');

        if (!fechaOK || !horaOK) {
          await sendWhatsAppMessage(from, '⚠️ Formato inválido. Usa *YYYY-MM-DD HH:mm* (ej.: 2025-11-15 15:00).');
          return res.sendStatus(200);
        }

        const fechaHoraNorm = `${fechaStr} ${normalizarHora(horaStrRaw)}`;
        if (!esHorarioLaboralEnFecha(fechaHoraNorm)) {
          await sendWhatsAppMessage(
            from,
            '⏰ Ese horario está *fuera de atención*.\nL-V: 8:00–12:30 y 14:00–18:00 · Sáb: 8:00–12:30.\nIndícame otra *fecha y hora* dentro del horario. 😊'
          );
          return res.sendStatus(200);
        }

        estado.datos.fechaHora = fechaHoraNorm;
        estado.paso = 'esperandoTipo';
        await sendWhatsAppMessage(from, '📸 Perfecto. ¿Qué *tipo de sesión* deseas? (ej.: sesión familiar, fotos para título, etc.)');
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
        await sendWhatsAppMessage(
          from,
          ok
            ? `✅ Cita creada.\n👤 *${nombre}*\n📅 *${fechaHora}*\n📸 *${tipoSesion}*\n📞 *${telefono}*`
            : '❌ No pude crear la cita. Revisa los datos o avisa a un colaborador.'
        );
        delete estadosUsuarios[from];
        return res.sendStatus(200);
      }
    }

    // ===== Comandos / opciones
    const esTestCalendar = low === 'test calendar';
    const esComandoCita = low.startsWith('cita:');       // cita: YYYY-MM-DD HH:mm; tipo; telefono
    const esComandoCancelar = low.startsWith('cancelar:'); // cancelar: YYYY-MM-DD HH:mm; telefono
    const esMisCitas = low === 'mis citas' || low.includes('ver mis citas');

    const esSaludo =
      low.includes('hola') || low.includes('buenos días') || low.includes('buenos dias') ||
      low.includes('buenas tardes') || low.includes('buenas noches') || low.includes('hey') ||
      low.includes('qué tal') || low.includes('que tal');

    const usaIA = low.startsWith('ia:');

    const esOpcion1 = low === '1' || low.includes('foto estudio') || low.includes('fotoestudio');
    const esOpcion2 = low === '2' || low.includes('eventos sociales') || low.includes('paquetes de eventos') || low.includes('bodas') || low.includes('15 años') || low.includes('bautizo');
    const esOpcion3 = low === '3' || low.includes('impresión fotográfica') || low.includes('imprimir fotos');
    const esOpcion4 = low === '4' || low.includes('consultar orden') || low.includes('estado de mi pedido');
    const esOpcion5 = low === '5' || low.includes('agendar cita') || low.includes('reservar cita') || low.includes('reservar sesión') || low.includes('reservar sesion');

    let replyText = '';

    if (usaIA) {
      replyText = await preguntarAGemini(texto.substring(3).trim() || 'Responde como asistente de Arte Fotográfico.');
    } else if (esComandoCancelar) {
      const sin = texto.substring(9).trim();
      const [fechaStr, horaStrRaw] = (sin.split(';')[0] || '').trim().split(' ');
      const tel = (sin.split(';')[1] || from).trim();
      const fOK = /^\d{4}-\d{2}-\d{2}$/.test(fechaStr || '');
      const hOK = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(horaStrRaw || '');
      if (!fOK || !hOK) {
        replyText = '⚠️ Formato inválido. Usa: *cancelar: 2025-11-15 15:00; 50370000000*';
      } else {
        const fechaHora = `${fechaStr} ${normalizarHora(horaStrRaw)}`;
        const ok = await cancelarCitaEnCalendar(fechaHora, tel);
        replyText = ok
          ? `✅ He cancelado la cita.\n📅 *${fechaHora}*\n📞 *${tel}*`
          : '❌ No encontré una cita con esa fecha/hora y teléfono.';
      }
    } else if (esMisCitas) {
      const citas = await listarCitasPorTelefono(from);
      replyText = citas.length
        ? '📅 *Tus próximas citas:*\n\n' + citas.map((c, i) => `${i+1}. ${c.fecha} — ${c.resumen}`).join('\n')
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
      const partes = sin.split(';').map(p => p.trim());
      const [fechaStr, horaStrRaw] = (partes[0] || '').split(' ');
      const tipo = partes[1] || 'fotográfica';
      const tel = partes[2] || from;

      const fOK = /^\d{4}-\d{2}-\d{2}$/.test(fechaStr || '');
      const hOK = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(horaStrRaw || '');
      if (!fOK || !hOK) {
        replyText = '⚠️ Formato de cita inválido.\nUsa: *cita: 2025-11-15 15:00; sesión familiar; 50370000000*';
      } else {
        const fechaHora = `${fechaStr} ${normalizarHora(horaStrRaw)}`;
        if (!esHorarioLaboralEnFecha(fechaHora)) {
          replyText = '⏰ Ese horario está fuera de atención.\nL-V: 8:00–12:30 y 14:00–18:00 · Sáb: 8:00–12:30.\nElige otra fecha/hora dentro del horario. 😊';
        } else {
          const ok = await crearCitaEnCalendar(fechaHora, tipo, tel, null);
          replyText = ok
            ? `✅ Cita creada.\n📅 *${fechaHora}*\n📸 *${tipo}*\n📞 *${tel}*`
            : '❌ Hubo un problema al crear la cita. Intenta de nuevo.';
        }
      }
    } else if (esTestCalendar) {
      replyText = (await crearEventoDePruebaCalendar('Cliente de prueba', from))
        ? '✅ Evento de prueba creado para dentro de 1 hora. Revisa Google Calendar.'
        : '❌ No pude crear el evento de prueba. Revisa credenciales.';
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
        'Cuéntame *tipo de evento, fecha y lugar* para cotizar (precios personalizados).';
    } else if (esOpcion3) {
      replyText =
        '🖨️ *IMPRESIÓN FOTOGRÁFICA*\n\n' +
        'Trae tus fotos en USB, WhatsApp o correo. Tenemos línea aficionado y línea profesional.\n' +
        '¿Qué tamaño deseas imprimir?';
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
      replyText = await preguntarAGemini(texto);
    }

    if (replyText) await sendWhatsAppMessage(from, replyText);
    res.sendStatus(200);
  } catch (e) {
    console.error('⚠️ Error webhook:', e);
    res.sendStatus(200);
  }
});

app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
