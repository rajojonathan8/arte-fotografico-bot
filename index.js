require('dotenv').config();

const { google } = require('googleapis');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

/* ====== Variables de entorno (Render) ====== */
const token = process.env.WHATSAPP_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // opcional, no se usa en este archivo
const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

/* ====== Fijos de tu app Meta ====== */
const VERIFY_TOKEN = 'MI_TOKEN_SECRETO_ARTE_FOTOGRAFICO';
const PHONE_NUMBER_ID = '805856909285040';

/* ====== Estado por usuario (flujo guiado) ====== */
const estadosUsuarios = {}; // { [from]: { paso, datos: { nombre, fecha, hora, tipo, telefono } } }

/* ====== Contexto negocio para IA ====== */
const NEGOCIO_CONTEXT = `
Eres el Asistente "Arte Fotográfico" (Sonsonate, El Salvador).
Tono: amable, profesional, claro y breve (máx. 3 líneas).
Horarios: Lun–Vie 8:00–12:30 y 14:00–18:00; Sáb 8:00–12:30; Dom cerrado.
Servicios: Foto estudio (títulos/documentos, sesiones), eventos sociales, impresión fotográfica.
Dirección: Sonsonate, El Salvador. Nunca inventes precios ni información no confirmada.
Si faltan datos, pregunta de forma cortés.
`;

/* ====== Google Calendar: auth con service account ====== */
let serviceAccount = null;
if (GOOGLE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
  } catch (e) {
    console.error('❌ Error al parsear GOOGLE_SERVICE_ACCOUNT:', e.message);
  }
}

async function getCalendarClient() {
  if (!serviceAccount) { console.error('⚠️ No hay serviceAccount cargado'); return null; }
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    console.error('⚠️ serviceAccount sin client_email o private_key');
    return null;
  }
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
  const authClient = await auth.getClient();
  return google.calendar({ version: 'v3', auth: authClient });
}

/* ====== Utilidades de fecha/hora ====== */
function pad2(n) { return String(n).padStart(2, '0'); }

function esDomingoFecha(dateObj) {
  const tz = 'America/El_Salvador';
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: tz, weekday: 'short' }).formatToParts(dateObj);
  // getDay con TZ local:
  const local = new Date(dateObj.toLocaleString('en-US', { timeZone: tz }));
  return local.getDay() === 0; // 0=domingo
}

function esHorarioLaboralEnFecha(datetimeStr) {
  // Espera "YYYY-MM-DD HH:mm"
  const [fecha, hora] = (datetimeStr || '').split(' ');
  if (!fecha || !hora) return false;
  const [Y, M, D] = fecha.split('-').map(Number);
  const [h, m] = hora.split(':').map(Number);

  // Construye fecha local de El Salvador
  const local = new Date(`${pad2(Y)}-${pad2(M)}-${pad2(D)}T${pad2(h)}:${pad2(m)}:00`);
  const tzLocal = new Date(local.toLocaleString('en-US', { timeZone: 'America/El_Salvador' }));

  const day = tzLocal.getDay(); // 0=dom,6=sáb
  const hour = tzLocal.getHours();
  const minute = tzLocal.getMinutes();
  const hDec = hour + minute / 60;

  if (day === 0) return false;              // Domingo cerrado
  if (day >= 1 && day <= 5) {               // Lun–Vie
    return (hDec >= 8 && hDec <= 12.5) || (hDec >= 14 && hDec <= 18);
  }
  if (day === 6) {                           // Sáb
    return (hDec >= 8 && hDec <= 12.5);
  }
  return false;
}

function formatearFechaHoraLocal(dateObj) {
  const opciones = {
    timeZone: 'America/El_Salvador',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  };
  const partes = new Intl.DateTimeFormat('en-CA', opciones).formatToParts(dateObj);
  let y, mo, d, h, mi;
  for (const p of partes) {
    if (p.type === 'year') y = p.value;
    if (p.type === 'month') mo = p.value;
    if (p.type === 'day') d = p.value;
    if (p.type === 'hour') h = p.value;
    if (p.type === 'minute') mi = p.value;
  }
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

/* ====== Calendar: crear/cancelar ====== */
async function crearEventoDePruebaCalendar(nombreCliente, telefono) {
  try {
    const calendar = await getCalendarClient();
    if (!calendar || !GOOGLE_CALENDAR_ID) return false;

    const ahora = new Date();
    const inicioLocal = new Date(ahora.getTime() + 60 * 60 * 1000);
    const finLocal = new Date(inicioLocal.getTime() + 30 * 60 * 1000);

    const startTxt = formatearFechaHoraLocal(inicioLocal).replace(' ', 'T') + ':00';
    const endTxt = formatearFechaHoraLocal(finLocal).replace(' ', 'T') + ':00';

    const evento = {
      summary: `Cita de prueba con ${nombreCliente || 'cliente de WhatsApp'}`,
      description: `Cita creada automáticamente desde el bot de Arte Fotográfico. Teléfono: ${telefono || ''}`,
      start: { dateTime: startTxt, timeZone: 'America/El_Salvador' },
      end:   { dateTime: endTxt,   timeZone: 'America/El_Salvador' }
    };

    const res = await calendar.events.insert({ calendarId: GOOGLE_CALENDAR_ID, requestBody: evento });
    console.log('✅ Evento de prueba creado en Calendar:', res.data.id);
    return true;
  } catch (error) {
    console.error('❌ Error al crear evento de prueba en Calendar:', error.response?.data || error.message);
    return false;
  }
}

async function crearCitaEnCalendar(fechaHoraTexto, tipoSesion, telefono, nombre) {
  try {
    const calendar = await getCalendarClient();
    if (!calendar || !GOOGLE_CALENDAR_ID) return false;

    // fechaHoraTexto: "YYYY-MM-DD HH:mm" (local)
    const [fechaStr, horaStr] = fechaHoraTexto.split(' ');
    const [anio, mes, dia] = fechaStr.split('-').map(Number);
    const [hora, minuto] = horaStr.split(':').map(Number);

    const inicioLocalTxt = `${anio}-${pad2(mes)}-${pad2(dia)}T${pad2(hora)}:${pad2(minuto)}:00`;
    const totalMin = hora * 60 + minuto + 60; // +1h
    const hFin = Math.floor(totalMin / 60);
    const mFin = totalMin % 60;
    const finLocalTxt = `${anio}-${pad2(mes)}-${pad2(dia)}T${pad2(hFin)}:${pad2(mFin)}:00`;

    const evento = {
      summary: `Sesión ${tipoSesion || 'fotográfica'} - ${nombre || 'Cliente WhatsApp'}`,
      description:
        `Sesión agendada desde el bot de Arte Fotográfico.\n` +
        `Cliente: ${nombre || ''}\n` +
        `Teléfono: ${telefono || ''}`,
      start: { dateTime: inicioLocalTxt, timeZone: 'America/El_Salvador' },
      end:   { dateTime: finLocalTxt,   timeZone: 'America/El_Salvador' }
    };

    const res = await calendar.events.insert({ calendarId: GOOGLE_CALENDAR_ID, requestBody: evento });
    console.log('✅ Cita creada en Calendar:', res.data.id);
    return true;
  } catch (error) {
    console.error('❌ Error al crear cita en Calendar:', error.response?.data || error.message);
    return false;
  }
}

async function cancelarCitaEnCalendar(fechaHoraTexto, telefono) {
  try {
    const calendar = await getCalendarClient();
    if (!calendar || !GOOGLE_CALENDAR_ID) return false;

    const [fechaStr, horaStr] = fechaHoraTexto.split(' ');
    if (!fechaStr || !horaStr) return false;

    const [Y, M, D] = fechaStr.split('-').map(Number);
    const inicioDiaLocal = new Date(Y, M - 1, D, 0, 0, 0);
    const finDiaLocal = new Date(Y, M - 1, D, 23, 59, 59);

    const listRes = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: inicioDiaLocal.toISOString(),
      timeMax: finDiaLocal.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const items = listRes.data.items || [];
    const telNum = (telefono || '').replace(/[^0-9]/g, '');
    const ult4 = telNum.slice(-4);

    let target = null;
    for (const ev of items) {
      let inicioEvTxt = '';
      if (ev.start?.dateTime) {
        inicioEvTxt = formatearFechaHoraLocal(new Date(ev.start.dateTime)); // "YYYY-MM-DD HH:mm"
      }
      if (inicioEvTxt !== fechaHoraTexto) continue;

      const desc = (ev.description || '').toLowerCase();
      const sum = (ev.summary || '').toLowerCase();
      const hit = (telNum && (desc.includes(telNum) || sum.includes(telNum))) ||
                  (ult4 && desc.includes(ult4));
      if (hit) { target = ev; break; }
    }

    if (!target) return false;

    await calendar.events.delete({ calendarId: GOOGLE_CALENDAR_ID, eventId: target.id });
    console.log('✅ Cita eliminada en Calendar:', target.id);
    return true;
  } catch (error) {
    console.error('❌ Error al cancelar cita en Calendar:', error.response?.data || error.message);
    return false;
  }
}

/* ====== IA: comprensión de intención + entidades ====== */
async function interpretarMensajeConIA(texto) {
  if (!GEMINI_API_KEY) return null;
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY;

  const prompt = `${NEGOCIO_CONTEXT}
Devuelve SOLO JSON (sin texto extra) con este esquema:
{
  "intent": "GREETING | BOOK_APPT | CANCEL_APPT | SERVICES_INFO | CHECK_ORDER | SMALL_TALK | OTHER",
  "entities": {
    "name": string|null,
    "phone": string|null,
    "session_type": string|null,
    "datetime": "YYYY-MM-DD HH:mm" | null,
    "date": "YYYY-MM-DD" | null,
    "time": "HH:mm" | null
  },
  "confidence": number
}

Cliente dice: "${texto}"`;

  try {
    const r = await axios.post(url, {
      contents: [{ parts: [{ text: prompt }]}],
      generationConfig: { response_mime_type: "application/json" }
    });
    const raw = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return JSON.parse(raw);
  } catch (e) {
    console.error('interpretarMensajeConIA error:', e.response?.data || e.message);
    return null;
  }
}

/* ====== IA: respuesta libre breve ====== */
async function preguntarAGemini(mensajeUsuario) {
  if (!GEMINI_API_KEY) {
    console.error('⚠️ No hay GEMINI_API_KEY configurada');
    return 'Con gusto te ayudo. ¿Podrías detallar un poco más tu consulta?';
  }
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY;
  try {
    const response = await axios.post(url, {
      contents: [{ parts: [{ text: `${NEGOCIO_CONTEXT}\nCliente: ${mensajeUsuario}\nResponde como asistente (máx 3 líneas).` }]}]
    });
    const texto = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return (texto || '').trim() || '¿En qué puedo apoyarte?';
  } catch (error) {
    console.error('❌ Error al llamar a Gemini:', error.response?.data || error.message);
    return 'Ocurrió un problema al usar la IA. Intentemos de nuevo.';
  }
}

/* ====== Express ====== */
app.use(bodyParser.json());

app.get('/', (req, res) => {
  res.send('Servidor Arte Fotográfico activo 🚀');
});

/* ====== Webhook GET (verificación) ====== */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const tokenVerify = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && tokenVerify && mode === 'subscribe' && tokenVerify === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado correctamente');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Falló la verificación del webhook');
    res.sendStatus(403);
  }
});

/* ====== Enviar mensaje a WhatsApp ====== */
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  try {
    const resp = await axios.post(url, {
      messaging_product: 'whatsapp',
      to, text: { body: text }
    }, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    console.log('✅ Mensaje enviado a WhatsApp:', resp.data);
  } catch (error) {
    console.error('❌ Error al enviar mensaje a WhatsApp:', error.response?.data || error.message);
  }
}

/* ====== Webhook POST (mensajería) ====== */
app.post('/webhook', async (req, res) => {
  console.log('📩 Webhook recibido:');
  console.dir(req.body, { depth: null });

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (messages?.[0]) {
      const message = messages[0];
      const from = message.from; // número del cliente
      const msgBody = message.text?.body || '';
      const texto = msgBody.trim();
      const textoLower = texto.toLowerCase();

      /* ====== Comandos legacy (soporte) ====== */
      const esTestCalendar = textoLower === 'test calendar';
      const esComandoCita = textoLower.startsWith('cita:');
      const esComandoCancelar = textoLower.startsWith('cancelar:');

      let replyText = '';

      // 1) Si hay flujo guiado activo para este usuario, continúa el slot filling
      let estado = estadosUsuarios[from];

      // ---- Flujo guiado (si existe estado) ----
      if (estado) {
        const datos = estado.datos || {};
        switch (estado.paso) {
          case 'esperandoNombre': {
            datos.nombre = texto;
            estadosUsuarios[from] = { paso: 'esperandoFecha', datos };
            replyText = 'Gracias. ¿Para qué *fecha* deseas la cita? (formato: AAAA-MM-DD)';
            await sendWhatsAppMessage(from, replyText);
            return res.sendStatus(200);
          }
          case 'esperandoFecha': {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
              replyText = 'Por favor usa el formato AAAA-MM-DD. Ej: 2025-11-20';
              await sendWhatsAppMessage(from, replyText);
              return res.sendStatus(200);
            }
            datos.fecha = texto;
            estadosUsuarios[from] = { paso: 'esperandoHora', datos };
            replyText = 'Perfecto. ¿A qué *hora*? (formato 24h HH:mm, ej: 15:30)';
            await sendWhatsAppMessage(from, replyText);
            return res.sendStatus(200);
          }
          case 'esperandoHora': {
            if (!/^\d{2}:\d{2}$/.test(texto)) {
              replyText = 'Por favor usa el formato HH:mm (24h). Ej: 15:30';
              await sendWhatsAppMessage(from, replyText);
              return res.sendStatus(200);
            }
            datos.hora = texto;
            const datetime = `${datos.fecha} ${datos.hora}`;
            if (!esHorarioLaboralEnFecha(datetime)) {
              replyText =
                '⏰ Esa hora está fuera de nuestro horario.\n' +
                'Lun–Vie 8:00–12:30 / 14:00–18:00; Sáb 8:00–12:30.\n' +
                '¿Podrías indicar otra hora dentro del horario?';
              await sendWhatsAppMessage(from, replyText);
              return res.sendStatus(200);
            }
            estadosUsuarios[from] = { paso: 'esperandoTipo', datos };
            replyText = 'Genial. ¿Qué *tipo de sesión* deseas (título, familiar, pareja, bebé, etc.)?';
            await sendWhatsAppMessage(from, replyText);
            return res.sendStatus(200);
          }
          case 'esperandoTipo': {
            datos.tipo = texto;
            estadosUsuarios[from] = { paso: 'esperandoTelefono', datos };
            replyText = 'Para finalizar, ¿me compartes tu *número de contacto*? (o responde "usar este" para usar el que estás usando aquí)';
            await sendWhatsAppMessage(from, replyText);
            return res.sendStatus(200);
          }
          case 'esperandoTelefono': {
            datos.telefono = (textoLower === 'usar este') ? from : texto;
            const datetime = `${datos.fecha} ${datos.hora}`;

            const ok = await crearCitaEnCalendar(
              datetime,
              datos.tipo || 'fotográfica',
              datos.telefono,
              datos.nombre || 'Cliente WhatsApp'
            );

            replyText = ok
              ? `✅ Cita creada para *${datetime}* (${datos.tipo}).\nA nombre de *${datos.nombre}*.`
              : '❌ No pude crear la cita ahora. ¿Probamos con otra hora?';

            delete estadosUsuarios[from];
            await sendWhatsAppMessage(from, replyText);
            return res.sendStatus(200);
          }
          default: {
            delete estadosUsuarios[from];
          }
        }
      }

      // 2) Si no hay flujo guiado, primero soportamos comandos legacy rápidos
      if (esComandoCita) {
        const sinPrefijo = texto.substring(5).trim();
        const partes = sinPrefijo.split(';').map(p => p.trim());
        const fechaHoraTexto = partes[0];
        const tipoSesion = partes[1] || 'fotográfica';
        const telefonoCliente = partes[2] || from;

        if (!fechaHoraTexto) {
          replyText = 'Formato inválido. Ejemplo:\n' +
            'cita: 2025-11-20 15:00; sesión familiar; 5037XXXXXX';
        } else if (!esHorarioLaboralEnFecha(fechaHoraTexto)) {
          replyText =
            '⏰ Esa hora está fuera de nuestro horario.\n' +
            'Lun–Vie 8:00–12:30 / 14:00–18:00; Sáb 8:00–12:30.\n' +
            '¿Podrías indicar otra hora dentro del horario?';
        } else {
          const ok = await crearCitaEnCalendar(fechaHoraTexto, tipoSesion, telefonoCliente, 'Cliente WhatsApp');
          replyText = ok
            ? `✅ Cita creada para *${fechaHoraTexto}* (${tipoSesion}).`
            : '❌ No pude crear la cita ahora. ¿Probamos con otra hora?';
        }
        await sendWhatsAppMessage(from, replyText);
        return res.sendStatus(200);
      }

      if (esComandoCancelar) {
        const sinPrefijo = texto.substring(9).trim();
        const partes = sinPrefijo.split(';').map(p => p.trim());
        const fechaHoraTexto = partes[0];
        const telefonoCliente = partes[1] || from;

        if (!fechaHoraTexto) {
          replyText = 'Formato inválido. Ejemplo:\n' +
            'cancelar: 2025-11-20 15:00; 5037XXXXXX';
        } else {
          const ok = await cancelarCitaEnCalendar(fechaHoraTexto, telefonoCliente);
          replyText = ok
            ? `✅ He cancelado la cita de *${fechaHoraTexto}*.`
            : '❌ No encontré una cita con esos datos. ¿Podrías verificar la fecha/hora?';
        }
        await sendWhatsAppMessage(from, replyText);
        return res.sendStatus(200);
      }

      if (esTestCalendar) {
        const ok = await crearEventoDePruebaCalendar('Cliente de prueba', from);
        replyText = ok
          ? '✅ Evento de prueba creado para dentro de 1 hora. Revisa tu Google Calendar 🗓️'
          : '❌ No pude crear el evento de prueba. Revisa credenciales en Render.';
        await sendWhatsAppMessage(from, replyText);
        return res.sendStatus(200);
      }

      // 3) IA para entender intención natural
      const nlu = await interpretarMensajeConIA(texto);
      const intent = nlu?.intent || 'OTHER';
      const ent = nlu?.entities || {};
      const nombreIA = ent.name || null;
      const telefonoIA = ent.phone || from;
      const tipoSesionIA = ent.session_type || null;
      const datetimeIA = ent.datetime || (ent.date && ent.time ? `${ent.date} ${ent.time}` : null);

      // Router por intención (sin estado previo)
      if (intent === 'GREETING') {
        replyText =
          '👋 ¡Hola! Gracias por contactar con Arte Fotográfico 📸\n' +
          '¿En qué puedo ayudarte hoy?\n\n' +
          '1️⃣ Foto estudio\n' +
          '2️⃣ Eventos sociales\n' +
          '3️⃣ Impresión fotográfica\n' +
          '4️⃣ Consultar orden\n' +
          '5️⃣ Agenda tu cita';
      }
      else if (intent === 'SERVICES_INFO') {
        replyText = 'Ofrecemos foto estudio (títulos, sesiones), eventos sociales y impresión fotográfica. ¿Qué necesitas exactamente?';
      }
      else if (intent === 'BOOK_APPT') {
        if (!datetimeIA) {
          estadosUsuarios[from] = { paso: 'esperandoNombre', datos: {} };
          replyText = '¡Perfecto! Para agendar, ¿me compartes tu *nombre completo*?';
        } else if (!esHorarioLaboralEnFecha(datetimeIA)) {
          replyText =
            '⏰ Esa hora está fuera de nuestro horario.\n' +
            'Lun–Vie 8:00–12:30 / 14:00–18:00; Sáb 8:00–12:30.\n' +
            '¿Te sirve dentro de ese horario?';
        } else {
          const ok = await crearCitaEnCalendar(
            datetimeIA,
            tipoSesionIA || 'fotográfica',
            telefonoIA,
            nombreIA || 'Cliente WhatsApp'
          );
          replyText = ok
            ? `✅ Cita creada para *${datetimeIA}* (${tipoSesionIA || 'fotográfica'}).`
            : '❌ No pude crear la cita ahora. ¿Probamos con otra hora?';
        }
      }
      else if (intent === 'CANCEL_APPT') {
        if (!datetimeIA) {
          replyText = 'Para cancelar, dime la *fecha y hora* de la cita (ej. 2025-11-20 15:00).';
        } else {
          const ok = await cancelarCitaEnCalendar(datetimeIA, telefonoIA);
          replyText = ok
            ? `✅ He cancelado tu cita de *${datetimeIA}*.`
            : '❌ No encontré una cita con esos datos. ¿Podrías verificar la fecha/hora?';
        }
      }
      else if (intent === 'CHECK_ORDER') {
        replyText = 'Con gusto consulto tu orden. ¿Me compartes el número de orden o el nombre completo del pedido?';
      }
      else if (intent === 'SMALL_TALK') {
        replyText = await preguntarAGemini(texto);
      }
      else {
        // Fallback IA
        replyText = await preguntarAGemini(texto);
      }

      // Opciones por número como fallback directo
      const t = textoLower;
      if (!estadosUsuarios[from]) {
        if (['1', 'foto estudio', 'fotoestudio', 'estudio de fotos'].some(k => t.includes(k))) {
          replyText =
            '📷 *SERVICIO FOTO ESTUDIO*\n' +
            'Títulos y documentos (Bachiller, U. Sonsonate 7x9, UMA 6x8), sesiones personales/familiares, y más.\n' +
            '¿Qué necesitas específicamente?';
        } else if (['2', 'eventos sociales', 'bodas', 'quince', '15 años', 'bautizo', 'bautizos'].some(k => t.includes(k))) {
          replyText =
            '💍 *EVENTOS SOCIALES*\n' +
            'Paquetes para bodas, 15 años, bautizos, comuniones, infantiles y más.\n' +
            '¿Tipo de evento, fecha y lugar?';
        } else if (['3', 'impresión fotográfica', 'imprimir fotos', 'impresiones'].some(k => t.includes(k))) {
          replyText =
            '🖨️ *IMPRESIÓN FOTOGRÁFICA*\n' +
            'Impresiones de alta calidad. Puedes enviar por WhatsApp, USB o correo.\n' +
            '¿Qué tamaños necesitas?';
        } else if (['4', 'consultar orden', 'estado de mi pedido'].some(k => t.includes(k))) {
          replyText =
            '📦 *CONSULTAR ORDEN*\n' +
            'Compárteme tu número de orden o nombre completo para verificar.';
        } else if (['5', 'agenda tu cita', 'agendar cita', 'reservar'].some(k => t.includes(k))) {
          estadosUsuarios[from] = { paso: 'esperandoNombre', datos: {} };
          replyText = '¡Perfecto! Para agendar, ¿me compartes tu *nombre completo*?';
        }
      }

      await sendWhatsAppMessage(from, replyText);
    }
  } catch (err) {
    console.error('⚠️ Error procesando el webhook:', err);
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
