require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// 🔐 Variables de entorno (Render)
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

// ⚠️ Datos fijos de configuración
const VERIFY_TOKEN = 'MI_TOKEN_SECRETO_ARTE_FOTOGRAFICO'; // mismo que en Meta
const PHONE_NUMBER_ID = '805856909285040';

// Estado simple por usuario (flujo de citas guiadas)
const estadosUsuarios = {}; 
// estadosUsuarios[telefono] = { paso: 'esperandoNombre' | 'esperandoFecha' | 'esperandoTipo' | 'esperandoTelefono', datos: {...} }

// ================== CARGA DE SERVICIOS (JSON) ==================
let serviciosData = null;

function cargarServicios() {
  try {
    const ruta = path.join(__dirname, 'servicios.json');
    const raw = fs.readFileSync(ruta, 'utf8');
    serviciosData = JSON.parse(raw);
    console.log('✅ servicios.json cargado.');
  } catch (e) {
    console.error('❌ No se pudo cargar servicios.json:', e.message);
    serviciosData = null;
  }
}
cargarServicios();

// Helpers para armar contexto desde JSON, según la pregunta del cliente
function normalizar(t) {
  return (t || '')
    .toString()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function incluyeAlguna(palabras, texto) {
  const tx = normalizar(texto);
  return palabras.some(p => tx.includes(normalizar(p)));
}

function formatearHorario(h) {
  if (!h) return '';
  const lv = (h.lunes_viernes || []).map(r => `${r.inicio}-${r.fin}`).join(' y ');
  const sab = (h.sabado || []).map(r => `${r.inicio}-${r.fin}`).join(' y ');
  const dom = (h.domingo || []).map(r => `${r.inicio}-${r.fin}`).join(' y ');
  let s = '🕓 Nuestro horario:\n';
  if (lv) s += `👉 Lunes a viernes: ${lv}\n`;
  if (sab) s += `👉 Sábados: ${sab}\n`;
  if (!sab && !lv) s += '👉 No definido\n';
  if (dom !== undefined) s += `👉 Domingos: ${dom ? dom : 'cerrado'}\n`;
  return s.trim();
}

function contextoHorariosDireccionSiAplica(pregunta) {
  if (!serviciosData) return '';
  const ask = normalizar(pregunta);
  let bloques = [];
  // Si preguntan por horario/abren/cierran
  if (incluyeAlguna(['horario','hora','abren','cierran','atendiendo'], ask)) {
    bloques.push(formatearHorario(serviciosData.horario));
  }
  // Si preguntan por dirección/ubicación
  if (incluyeAlguna(['direccion','ubicacion','donde estan','donde queda','como llegar','mapa'], ask)) {
    bloques.push(`📍 Dirección: ${serviciosData.direccion}`);
  }
  return bloques.filter(Boolean).join('\n\n');
}

function listarPreciosImpresion() {
  if (!serviciosData || !serviciosData.impresion_fotografica) return '';
  const imp = serviciosData.impresion_fotografica;
  let s = '🖨️ *Impresión fotográfica*\n';
  if (imp.nota_general) s += `${imp.nota_general}\n\n`;

  if (imp.aficionado) {
    s += '— *Línea Aficionado* —\n';
    if (imp.aficionado.nota_tecnica) s += `_${imp.aficionado.nota_tecnica}_\n`;
    (imp.aficionado.precios || []).forEach(p => {
      s += `• ${p.tamano}: $${p.precio}\n`;
    });
    s += '\n';
  }
  if (imp.profesional) {
    s += '— *Línea Profesional* —\n';
    (imp.profesional.precios || []).forEach(p => {
      s += `• ${p.tamano}: $${p.precio}\n`;
    });
  }
  return s.trim();
}

function buscarServiciosCoincidentes(pregunta) {
  // Devuelve trozos relevantes (precios, vestimenta, tamaños) según palabras clave
  if (!serviciosData) return '';
  const ask = normalizar(pregunta);

  const partes = [];

  // FOTO ESTUDIO – títulos/doc
  const te = serviciosData?.foto_estudio?.titulos_documentos || [];
  te.forEach(item => {
    const txt = [
      item.servicio, item.tamano, item.tipo_foto,
      item.vestimenta_senoritas, item.vestimenta_caballeros
    ].filter(Boolean).join(' ');
    if (incluyeAlguna([item.servicio], ask)) {
      let bloque = `• *${item.servicio}* — $${item.precio} — ${item.duracion_min} min`;
      if (item.tamano) bloque += ` — Tamaño: ${item.tamano}`;
      if (item.tipo_foto) bloque += ` — Tipo: ${item.tipo_foto}`;
      if (item.vestimenta_senoritas || item.vestimenta_caballeros) {
        bloque += `\n  Vestimenta:\n   - Señoritas: ${item.vestimenta_senoritas || '—'}\n   - Caballeros: ${item.vestimenta_caballeros || '—'}`;
      }
      if (item.observaciones) bloque += `\n  Obs.: ${item.observaciones}`;
      partes.push(bloque);
    }
  });

  // FOTO ESTUDIO – migratorios
  const mig = serviciosData?.foto_estudio?.migratorios || [];
  mig.forEach(item => {
    if (incluyeAlguna([item.servicio, 'visa', 'americana', 'canadiense', 'mexicana'], ask)) {
      let bloque = `• *${item.servicio}* — $${item.precio} — ${item.duracion_min} min`;
      if (item.tamano) bloque += ` — Tamaño: ${item.tamano}`;
      if (item.tipo_foto) bloque += ` — Tipo: ${item.tipo_foto}`;
      if (item.cantidad_fotos) bloque += ` — Entrega: ${item.cantidad_fotos} fotos`;
      if (item.observaciones) bloque += `\n  Obs.: ${item.observaciones}`;
      partes.push(bloque);
    }
  });

  // Impresión fotográfica (si preguntan por tamaños/precios de impresión)
  if (incluyeAlguna(['impresion','imprimir','fotos impresas','linea profesional','aficionado','4x6','5x7','6x8','8x10','11x14','20x24','30x40'], ask)) {
    partes.push(listarPreciosImpresion());
  }

  // Sesiones / retratos → texto orientativo
  if (incluyeAlguna(['sesion','sesión','pareja','familia','graduados','portafolio','navide','bebes','bebés'], ask)) {
    const nota = serviciosData?.foto_estudio?.sesiones_fotograficas?.nota_atencion;
    if (nota) partes.push(`📸 ${nota}`);
  }
  if (incluyeAlguna(['retrato','blanco y negro','artistico','artístico','contemporaneo','contemporáneo'], ask)) {
    const nota = serviciosData?.foto_estudio?.retratos_especiales?.nota_atencion;
    if (nota) partes.push(`🖼️ ${nota}`);
  }

  // Eventos sociales
  if (incluyeAlguna(['bodas','boda','15 años','quince','bautizo','comunion','comunión','baby shower','fiesta infantil','outdoor','exterior'], ask)) {
    const nota = serviciosData?.eventos_sociales?.cotizacion?.nota_atencion;
    if (nota) partes.push(`💍 ${nota}\nPara cotizar: tipo de evento, fecha y lugar.`);
  }

  // Si preguntan por dirección durante esos casos
  if (incluyeAlguna(['donde','direc','ubicacion','queda','mapa','google maps'], ask)) {
    partes.push(`📍 Dirección: ${serviciosData?.direccion || '—'}`);
  }

  return partes.filter(Boolean).join('\n\n').trim();
}

function construirContextoParaIA(pregunta) {
  if (!serviciosData) return '';
  const bloques = [];

  // Inyecta horario/dirección sólo si aplica
  const hdir = contextoHorariosDireccionSiAplica(pregunta);
  if (hdir) bloques.push(hdir);

  // Inyecta coincidencias de servicios/precios/vestimenta
  const match = buscarServiciosCoincidentes(pregunta);
  if (match) bloques.push(match);

  // Si no hubo coincidencias, pasa un resumen cortito para que la IA no invente
  if (!match && !hdir) {
    bloques.push(
      'Contexto de negocio: Estudio fotográfico en Sonsonate. ' +
      'Servicios: foto estudio (títulos/documentos, visados), sesiones personalizadas, eventos sociales, impresión (aficionado y profesional). ' +
      'Responde con máximo 3 líneas, claro y profesional. Si no hay datos exactos en el contexto, sugiere hablar con un asesor.'
    );
  }
  return bloques.join('\n\n');
}

// ================== GOOGLE CALENDAR ==================

let serviceAccount = null;

if (GOOGLE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
  } catch (e) {
    console.error('❌ Error al parsear GOOGLE_SERVICE_ACCOUNT:', e.message);
  }
}

async function getCalendarClient() {
  if (!serviceAccount) {
    console.error('⚠️ No hay serviceAccount cargado');
    return null;
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    console.error('⚠️ serviceAccount sin client_email o private_key');
    return null;
  }

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  const authClient = await auth.getClient();

  const calendar = google.calendar({
    version: 'v3',
    auth: authClient,
  });

  return calendar;
}

async function crearEventoDePruebaCalendar(nombreCliente, telefono) {
  try {
    const calendar = await getCalendarClient();
    if (!calendar) return false;
    if (!GOOGLE_CALENDAR_ID) {
      console.error('⚠️ Falta GOOGLE_CALENDAR_ID');
      return false;
    }

    const ahora = new Date();
    const inicio = new Date(ahora.getTime() + 60 * 60 * 1000); // dentro de 1 hora
    const fin = new Date(inicio.getTime() + 30 * 60 * 1000); // 30 min

    const evento = {
      summary: `Cita de prueba con ${nombreCliente || 'cliente de WhatsApp'}`,
      description: `Cita creada automáticamente desde el bot de Arte Fotográfico.\nTeléfono: ${telefono || ''}`,
      start: {
        dateTime: inicio.toISOString(),
        timeZone: 'America/El_Salvador',
      },
      end: {
        dateTime: fin.toISOString(),
        timeZone: 'America/El_Salvador',
      },
    };

    const res = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: evento,
    });

    console.log('✅ Evento de prueba creado en Calendar:', res.data.id);
    return true;
  } catch (error) {
    console.error('❌ Error al crear evento de prueba en Calendar:');
    if (error.response) console.error(error.response.data);
    else console.error(error.message);
    return false;
  }
}

// Crear cita (comando rápido o flujo guiado)
async function crearCitaEnCalendar(fechaHoraTexto, tipoSesion, telefono, nombreCliente) {
  try {
    console.log('💠 crearCitaEnCalendar =>', { fechaHoraTexto, tipoSesion, telefono, nombreCliente });

    const calendar = await getCalendarClient();
    if (!calendar) return false;
    if (!GOOGLE_CALENDAR_ID) return false;

    // Esperamos formato: "YYYY-MM-DD HH:mm"
    const [fechaStr, horaStr] = fechaHoraTexto.split(' ');
    if (!fechaStr || !horaStr) return false;

    const [anio, mes, dia] = fechaStr.split('-').map(Number);
    const [hora, minuto] = horaStr.split(':').map(Number);
    const pad2 = (n) => String(n).padStart(2, '0');

    const inicioLocal = `${anio}-${pad2(mes)}-${pad2(dia)}T${pad2(hora)}:${pad2(minuto)}:00`;
    const totalMinutosInicio = hora * 60 + minuto + 60; // +1h
    const horaFin = Math.floor(totalMinutosInicio / 60);
    const minutoFin = totalMinutosInicio % 60;
    const finLocal = `${anio}-${pad2(mes)}-${pad2(dia)}T${pad2(horaFin)}:${pad2(minutoFin)}:00`;

    const evento = {
      summary: `Sesión ${tipoSesion || 'fotográfica'} - ${nombreCliente || 'Cliente WhatsApp'}`,
      description:
        `Sesión agendada desde el bot de Arte Fotográfico.\n` +
        (nombreCliente ? `Nombre del cliente: ${nombreCliente}\n` : '') +
        `Teléfono: ${telefono || ''}`,
      start: { dateTime: inicioLocal, timeZone: 'America/El_Salvador' },
      end:   { dateTime: finLocal,    timeZone: 'America/El_Salvador' },
    };

    const res = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: evento,
    });

    console.log('✅ Cita creada en Calendar:', res.data.id);
    return true;
  } catch (error) {
    console.error('❌ Error al crear cita en Calendar:');
    if (error.response && error.response.data) console.error(JSON.stringify(error.response.data, null, 2));
    else console.error(error.message);
    return false;
  }
}

// Formatear Date a "YYYY-MM-DD HH:mm"
function formatearFechaHoraLocal(dateObj) {
  const opciones = {
    timeZone: 'America/El_Salvador',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  const partes = new Intl.DateTimeFormat('en-CA', opciones).formatToParts(dateObj);
  let year, month, day, hour, minute;
  for (const p of partes) {
    if (p.type === 'year') year = p.value;
    if (p.type === 'month') month = p.value;
    if (p.type === 'day') day = p.value;
    if (p.type === 'hour') hour = p.value;
    if (p.type === 'minute') minute = p.value;
  }
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

// Cancelar cita por fecha/hora + teléfono
async function cancelarCitaEnCalendar(fechaHoraTexto, telefono) {
  try {
    console.log('💠 cancelarCitaEnCalendar =>', { fechaHoraTexto, telefono });

    const calendar = await getCalendarClient();
    if (!calendar) return false;
    if (!GOOGLE_CALENDAR_ID) return false;

    const [fechaStr, horaStr] = fechaHoraTexto.split(' ');
    if (!fechaStr || !horaStr) return false;

    const [anio, mes, dia] = fechaStr.split('-').map(Number);
    const [hora, minuto] = horaStr.split(':').map(Number);

    const inicioDiaLocal = new Date(anio, mes - 1, dia, 0, 0, 0);
    const finDiaLocal = new Date(anio, mes - 1, dia, 23, 59, 59);

    const timeMin = inicioDiaLocal.toISOString();
    const timeMax = finDiaLocal.toISOString();

    const listRes = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const items = listRes.data.items || [];
    const telefonoLimpio = telefono.replace(/[^0-9]/g, '');
    const ultimos4 = telefonoLimpio.slice(-4);

    let eventoAEliminar = null;

    for (const ev of items) {
      const desc = (ev.description || '').toLowerCase();
      const resumen = (ev.summary || '').toLowerCase();
      let fechaEventoTexto = '';
      if (ev.start && ev.start.dateTime) {
        const fechaEv = new Date(ev.start.dateTime);
        fechaEventoTexto = formatearFechaHoraLocal(fechaEv);
      }
      if (fechaEventoTexto !== fechaHoraTexto) continue;
      const coincideTelefono =
        desc.includes(telefonoLimpio) ||
        resumen.includes(telefonoLimpio) ||
        (ultimos4 && desc.includes(ultimos4));
      if (coincideTelefono) { eventoAEliminar = ev; break; }
    }

    if (!eventoAEliminar) return false;

    await calendar.events.delete({
      calendarId: GOOGLE_CALENDAR_ID,
      eventId: eventoAEliminar.id,
    });

    console.log('✅ Cita eliminada en Calendar:', eventoAEliminar.id);
    return true;
  } catch (error) {
    console.error('❌ Error al cancelar cita en Calendar:');
    if (error.response && error.response.data) console.error(JSON.stringify(error.response.data, null, 2));
    else console.error(error.message);
    return false;
  }
}

// Listar citas próximas por teléfono (para "mis citas")
async function listarCitasPorTelefono(telefono) {
  try {
    const calendar = await getCalendarClient();
    if (!calendar || !GOOGLE_CALENDAR_ID) return [];

    const ahora = new Date();
    const dentroDe30Dias = new Date(ahora.getTime() + 30 * 24 * 60 * 60 * 1000);

    const timeMin = ahora.toISOString();
    const timeMax = dentroDe30Dias.toISOString();

    const listRes = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin,
      timeMax,
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
      if (ev.start && ev.start.dateTime) {
        const fechaEv = new Date(ev.start.dateTime);
        fechaTexto = formatearFechaHoraLocal(fechaEv);
      }

      resultados.push({ fecha: fechaTexto, resumen: ev.summary || 'Cita sin título' });
    }
    return resultados;
  } catch (error) {
    console.error('❌ Error al listar citas por teléfono:');
    if (error.response && error.response.data) console.error(JSON.stringify(error.response.data, null, 2));
    else console.error(error.message);
    return [];
  }
}

// ================== HORARIOS ==================
function esHorarioLaboral() {
  const ahora = new Date();
  const zonaLocal = ahora.toLocaleString('en-US', { timeZone: 'America/El_Salvador' });
  const fechaLocal = new Date(zonaLocal);
  const dia = fechaLocal.getDay(); // 0 = domingo, 6 = sábado
  const hora = fechaLocal.getHours();
  const minuto = fechaLocal.getMinutes();
  const horaDecimal = hora + minuto / 60;

  // Lunes a viernes: 8:00–12:30 y 14:00–18:00
  if (dia >= 1 && dia <= 5) {
    return (horaDecimal >= 8 && horaDecimal <= 12.5) || (horaDecimal >= 14 && horaDecimal <= 18);
  }
  // Sábado: 8:00–12:30
  if (dia === 6) {
    return horaDecimal >= 8 && horaDecimal <= 12.5;
  }
  // Domingo: cerrado
  return false;
}

function esDomingo() {
  const ahora = new Date();
  const zonaLocal = ahora.toLocaleString('en-US', { timeZone: 'America/El_Salvador' });
  const fechaLocal = new Date(zonaLocal);
  const dia = fechaLocal.getDay(); // 0 = domingo
  return dia === 0;
}

// Verificar si una FECHA/HORA específica está dentro del horario laboral ("YYYY-MM-DD HH:mm")
function esHorarioLaboralEnFecha(fechaHoraTexto) {
  const partes = fechaHoraTexto.split(' ');
  if (partes.length !== 2) return false;
  const [fechaStr, horaStr] = partes;
  const [anio, mes, dia] = fechaStr.split('-').map(Number);
  const [hora, minuto] = horaStr.split(':').map(Number);
  if ([anio, mes, dia, hora, minuto].some(isNaN)) return false;

  const fecha = new Date(anio, mes - 1, dia, hora, minuto);
  const diaSemana = fecha.getDay(); // 0=domingo, 6=sábado
  const horaDecimal = hora + minuto / 60;

  if (diaSemana >= 1 && diaSemana <= 5) {
    return (horaDecimal >= 8 && horaDecimal <= 12.5) || (horaDecimal >= 14 && horaDecimal <= 18);
  }
  if (diaSemana === 6) {
    return horaDecimal >= 8 && horaDecimal <= 12.5;
  }
  return false;
}

// ================== IA (Gemini / ChatGPT) ==================
async function preguntarAGemini(mensajeUsuario, contexto = '') {
  if (!GEMINI_API_KEY) {
    console.error('⚠️ No hay GEMINI_API_KEY configurada');
    return 'Por el momento no puedo usar la IA gratuita, pero con gusto te atiendo como asistente básico de Arte Fotográfico. 😊';
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY;

  const systemInstrucciones =
    'Eres el Asistente Arte Fotográfico: amable, profesional, claro y ordenado. ' +
    'Debes usar el CONTEXTO si existe para responder con datos reales (precios, tamaños, vestimenta, horarios, dirección). ' +
    'Si la pregunta requiere precios personalizados, sugiere hablar con un asesor o visitar el local. ' +
    'Máximo 3 líneas. Responde siempre en español.';

  try {
    const response = await axios.post(url, {
      contents: [
        {
          parts: [
            { text: `INSTRUCCIONES:\n${systemInstrucciones}` },
            { text: `CONTEXTO:\n${contexto || '(sin contexto)'}\n---\n` },
            { text: `PREGUNTA DEL CLIENTE:\n${mensajeUsuario}` }
          ]
        }
      ]
    });

    const texto =
      response.data &&
      response.data.candidates &&
      response.data.candidates[0] &&
      response.data.candidates[0].content &&
      response.data.candidates[0].content.parts &&
      response.data.candidates[0].content.parts[0] &&
      response.data.candidates[0].content.parts[0].text;

    return texto ? texto.trim() : 'La IA no pudo generar una respuesta en este momento.';
  } catch (error) {
    console.error('❌ Error al llamar a Gemini:');
    if (error.response) console.error(error.response.data);
    else console.error(error.message);
    return 'Ocurrió un problema al usar la IA gratuita (Gemini). Por favor, intenta de nuevo más tarde.';
  }
}

async function preguntarAChatGPT(mensajeUsuario, contexto = '') {
  if (!OPENAI_API_KEY) {
    console.error('⚠️ No hay OPENAI_API_KEY configurada');
    return 'Por el momento no puedo usar inteligencia artificial, pero con gusto te atiendo como asistente básico de Arte Fotográfico. 😊';
  }

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content:
              'Eres el Asistente Arte Fotográfico: amable, profesional, claro y ordenado. ' +
              'Usa el contexto si existe (precios, vestimenta, horarios). Responde siempre en español, máximo 3 líneas.'
          },
          { role: 'user', content: `CONTEXTO:\n${contexto || '(sin contexto)'}\n---\n` },
          { role: 'user', content: `PREGUNTA:\n${mensajeUsuario}` }
        ]
      },
      {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` }
      }
    );

    const respuesta =
      response.data.choices &&
      response.data.choices[0] &&
      response.data.choices[0].message &&
      response.data.choices[0].message.content;

    return respuesta ? respuesta.trim() : 'No pude generar una respuesta en este momento.';
  } catch (error) {
    console.error('❌ Error al llamar a ChatGPT:');
    if (error.response) console.error(error.response.data);
    else console.error(error.message);
    return 'Ocurrió un problema al usar la IA en este momento. Por favor, intenta de nuevo más tarde.';
  }
}

// Enviar mensaje WhatsApp
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

  try {
    const response = await axios.post(
      url,
      { messaging_product: 'whatsapp', to, text: { body: text } },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    console.log('✅ Mensaje enviado a WhatsApp:', response.data);
  } catch (error) {
    console.error('❌ Error al enviar mensaje a WhatsApp:');
    if (error.response) console.error(error.response.data);
    else console.error(error.message);
  }
}

// ================== WHATSAPP ==================
app.use(bodyParser.json());

// Ruta de prueba
app.get('/', (req, res) => {
  res.send('Servidor Arte Fotográfico activo 🚀');
});

// Webhook GET (verificación)
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

// Webhook POST (mensajes entrantes)
app.post('/webhook', async (req, res) => {
  console.log('📩 Webhook recibido:');
  console.dir(req.body, { depth: null });

  try {
    const entry = req.body.entry && req.body.entry[0];
    const changes = entry && entry.changes && entry.changes[0];
    const value = changes && changes.value;
    const messages = value && value.messages;

    if (!messages || !messages[0]) return res.sendStatus(200);

    const message = messages[0];
    const from = message.from;
    const msgBody = message.text && message.text.body ? message.text.body : '';

    console.log(`📨 Mensaje de ${from}: ${msgBody}`);

    const texto = msgBody.trim();
    const textoLower = texto.toLowerCase();

    // 🕓 Mensajes fuera de horario (según hora actual)
    if (!esHorarioLaboral()) {
      let mensajeRespuesta = '';

      if (esDomingo()) {
        mensajeRespuesta =
          '📸 *¡Gracias por contactarnos con Arte Fotográfico!* 💬\n\n' +
          'Hoy es *domingo* y nuestro estudio se encuentra *cerrado* por descanso del personal. 🛌\n\n' +
          `${formatearHorario(serviciosData?.horario || null)}\n\n` +
          'Puedes dejar tu mensaje con toda confianza y el lunes te responderemos en horario de atención. 😊';
      } else {
        mensajeRespuesta =
          '📸 *¡Gracias por contactarnos con Arte Fotográfico!* 💬\n\n' +
          'En este momento estamos *fuera de nuestro horario de atención*, pero con gusto te responderemos en cuanto estemos de vuelta. 😊\n\n' +
          `${formatearHorario(serviciosData?.horario || null)}\n\n` +
          '📍 Sonsonate, El Salvador.';
      }
      await sendWhatsAppMessage(from, mensajeRespuesta);
      return res.sendStatus(200);
    }

    // ================== FLUJO GUIADO DE CITA (OPCIÓN 5) ==================
    const estado = estadosUsuarios[from];

    if (estado && textoLower === 'cancelar cita') {
      delete estadosUsuarios[from];
      await sendWhatsAppMessage(from, '❌ He cancelado el proceso de agendar cita. Si deseas, envía *5* para empezar de nuevo.');
      return res.sendStatus(200);
    }

    if (estado) {
      if (estado.paso === 'esperandoNombre') {
        estado.datos.nombre = texto;
        estado.paso = 'esperandoFecha';
        await sendWhatsAppMessage(
          from,
          `📅 Perfecto, *${estado.datos.nombre}*.\n\nAhora indícame la *fecha y hora* en formato: 2025-11-15 15:00\n` +
          'Si deseas cancelar este proceso escribe "cancelar cita".'
        );
        return res.sendStatus(200);
      }

      if (estado.paso === 'esperandoFecha') {
        const okFormato = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(texto);
        if (!okFormato) {
          await sendWhatsAppMessage(from, '⚠️ Formato inválido. Usa: *YYYY-MM-DD HH:mm* (ej. 2025-11-15 15:00).');
          return res.sendStatus(200);
        }
        if (!esHorarioLaboralEnFecha(texto)) {
          await sendWhatsAppMessage(
            from,
            '⏰ Esa hora está fuera de nuestro horario de atención.\n\n' + formatearHorario(serviciosData?.horario || null) +
            '\n\nIndícame otra *fecha y hora* dentro del horario, por favor.'
          );
          return res.sendStatus(200);
        }
        estado.datos.fechaHora = texto;
        estado.paso = 'esperandoTipo';
        await sendWhatsAppMessage(from, '📸 Gracias. Ahora dime el *tipo de sesión* (ej.: sesión familiar, fotos para título, etc.).');
        return res.sendStatus(200);
      }

      if (estado.paso === 'esperandoTipo') {
        estado.datos.tipoSesion = texto;
        estado.paso = 'esperandoTelefono';
        await sendWhatsAppMessage(from, '📞 Genial. Por último, tu *número de contacto* (ej.: 5037XXXXXX).');
        return res.sendStatus(200);
      }

      if (estado.paso === 'esperandoTelefono') {
        estado.datos.telefono = texto || from;
        const { nombre, fechaHora, tipoSesion, telefono } = estado.datos;

        const ok = await crearCitaEnCalendar(fechaHora, tipoSesion, telefono, nombre);
        if (ok) {
          await sendWhatsAppMessage(
            from,
            '✅ He creado tu cita en el calendario de Arte Fotográfico.\n' +
            `👤 Nombre: *${nombre}*\n` +
            `📅 Fecha y hora: *${fechaHora}*\n` +
            `📸 Tipo de sesión: *${tipoSesion}*\n` +
            `📞 Contacto: *${telefono}*`
          );
        } else {
          await sendWhatsAppMessage(from, '❌ Ocurrió un problema al crear la cita. Revisa los datos o avisa a un colaborador.');
        }
        delete estadosUsuarios[from];
        return res.sendStatus(200);
      }
    }

    // ================== DETECCIÓN DE COMANDOS / OPCIONES ==================
    const esTestCalendar = textoLower === 'test calendar';
    const esComandoCita = textoLower.startsWith('cita:');
    const esComandoCancelar = textoLower.startsWith('cancelar:');
    const esMisCitas = textoLower === 'mis citas' || textoLower.includes('ver mis citas') || textoLower.includes('mis próximas citas');

    const esSaludo =
      textoLower.includes('hola') ||
      textoLower.includes('buenos dias') ||
      textoLower.includes('buenos días') ||
      textoLower.includes('buenas tardes') ||
      textoLower.includes('buenas noches') ||
      textoLower.includes('hey') ||
      textoLower.includes('qué tal') ||
      textoLower.includes('que tal');

    const usaIAForzado = textoLower.startsWith('ia:');

    const esOpcion1 =
      textoLower === '1' ||
      textoLower.includes('foto estudio') ||
      textoLower.includes('fotoestudio') ||
      textoLower.includes('estudio de fotos');

    const esOpcion2 =
      textoLower === '2' ||
      textoLower.includes('eventos sociales') ||
      textoLower.includes('evento social') ||
      textoLower.includes('paquetes de eventos') ||
      textoLower.includes('bodas') ||
      textoLower.includes('15 años') ||
      textoLower.includes('quince años') ||
      textoLower.includes('bautizos') ||
      textoLower.includes('bautizo');

    const esOpcion3 =
      textoLower === '3' ||
      textoLower.includes('impresión fotográfica') ||
      textoLower.includes('impresion fotografica') ||
      textoLower.includes('imprimir fotos') ||
      textoLower.includes('impresiones de fotos');

    const esOpcion4 =
      textoLower === '4' ||
      textoLower.includes('consultar orden') ||
      textoLower.includes('consulta de orden') ||
      textoLower.includes('estado de mi orden') ||
      textoLower.includes('estado de mi pedido') ||
      textoLower.includes('ver mi pedido') ||
      textoLower.includes('rastrear pedido');

    const esOpcion5 =
      textoLower === '5' ||
      textoLower.includes('agenda tu cita') ||
      textoLower.includes('agendar cita') ||
      textoLower.includes('sacar cita') ||
      textoLower.includes('hacer una cita') ||
      textoLower.includes('reservar cita') ||
      textoLower.includes('reservar sesión') ||
      textoLower.includes('reservar sesion');

    let replyText = '';

    // ================== RESPUESTAS ==================
    if (usaIAForzado) {
      const pregunta = texto.substring(3).trim() || 'Responde como asistente de Arte Fotográfico.';
      const contexto = construirContextoParaIA(pregunta);
      replyText = await preguntarAGemini(pregunta, contexto);

    } else if (esComandoCancelar) {
      const sinPrefijo = texto.substring(9).trim(); // "cancelar:"
      const partes = sinPrefijo.split(';').map(p => p.trim());
      const fechaHoraTexto = partes[0];
      const telefonoCliente = partes[1] || from;

      if (!fechaHoraTexto) {
        replyText = '⚠️ Formato inválido. Usa: cancelar: 2025-11-15 15:00; 50370000000';
      } else {
        const ok = await cancelarCitaEnCalendar(fechaHoraTexto, telefonoCliente);
        replyText = ok
          ? `✅ He cancelado la cita.\n📅 *${fechaHoraTexto}*\n📞 *${telefonoCliente}*`
          : '❌ No encontré una cita con esa fecha/hora y teléfono.';
      }

    } else if (esMisCitas) {
      const citas = await listarCitasPorTelefono(from);
      if (!citas.length) {
        replyText = '📅 No encontré citas próximas asociadas a tu número en los próximos 30 días.';
      } else {
        let tx = '📅 *Tus próximas citas:*\n\n';
        citas.forEach((c, i) => { tx += `${i + 1}. ${c.fecha} — ${c.resumen}\n`; });
        replyText = tx.trim();
      }

    } else if (esSaludo) {
      replyText =
        '👋 ¡Hola! Gracias por contactar con Arte Fotográfico 📸\n' +
        'Soy un asistente virtual con inteligencia artificial.\n' +
        '¿En qué puedo servirte hoy?\n\n' +
        'Por favor selecciona una opción escribiendo el número o el nombre del servicio que necesitas 👇\n' +
        '1️⃣ SERVICIO FOTO ESTUDIO\n' +
        '2️⃣ COTIZACIÓN DE PAQUETES DE EVENTOS SOCIALES\n' +
        '3️⃣ SERVICIO DE IMPRESIÓN FOTOGRÁFICA\n' +
        '4️⃣ CONSULTAR ORDEN\n' +
        '5️⃣ AGENDA TU CITA';

    } else if (esComandoCita) {
      const sinPrefijo = texto.substring(5).trim(); // "cita:"
      const partes = sinPrefijo.split(';').map(p => p.trim());
      const fechaHoraTexto = partes[0];
      const tipoSesion = partes[1] || 'fotográfica';
      const telefonoCliente = partes[2] || from;

      if (!fechaHoraTexto) {
        replyText = '⚠️ Formato inválido. Usa: cita: 2025-11-15 15:00; sesión familiar; 50370000000';
      } else if (!esHorarioLaboralEnFecha(fechaHoraTexto)) {
        replyText =
          '⏰ Esa hora está *fuera de horario*.\n\n' +
          formatearHorario(serviciosData?.horario || null) +
          '\n\nElige otra fecha/hora dentro del horario, por favor.';
      } else {
        const ok = await crearCitaEnCalendar(fechaHoraTexto, tipoSesion, telefonoCliente, null);
        replyText = ok
          ? `✅ Cita creada.\n📅 *${fechaHoraTexto}*\n📸 *${tipoSesion}*\n📞 *${telefonoCliente}*`
          : '❌ Ocurrió un problema al crear la cita. Revisa el formato o avisa a un colaborador.';
      }

    } else if (esTestCalendar) {
      const ok = await crearEventoDePruebaCalendar('Cliente de prueba', from);
      replyText = ok
        ? '✅ Evento de prueba creado para dentro de 1 hora. Revisa tu Google Calendar. 🗓️'
        : '❌ No pude crear el evento de prueba. Revisa credenciales de Google.';

    } else if (esOpcion1) {
      // Foto estudio (podemos dejar una descripción breve y dejar que IA complete con JSON si preguntan algo puntual)
      replyText =
        '📷 *SERVICIO FOTO ESTUDIO*\n' +
        'Título de Bachiller ($10), Títulos Universitarios USO 7x9 y UMA 6x8 ($20), Certificados/Escalafón/Carnets ($10), y visados (USA/Canadá/México $10/4 fotos).\n' +
        'Si necesitas vestimenta, tamaños o detalles exactos, dime cuál servicio y te doy la info.';

    } else if (esOpcion2) {
      replyText =
        '💍 *PAQUETES DE EVENTOS SOCIALES*\n' +
        'Bodas, 15 años, bautizos, comuniones, baby showers, infantiles, pre-15 y exteriores.\n' +
        'Dime tipo de evento, fecha y lugar para cotizar (precios personalizados).';

    } else if (esOpcion3) {
      replyText = listarPreciosImpresion() || '🖨️ Tenemos impresiones aficionado y profesional. Dime el tamaño que te interesa y te confirmo el precio.';

    } else if (esOpcion4) {
      replyText =
        '📦 *CONSULTAR ORDEN*\n' +
        'Envíame tu número de orden o tu nombre completo y comunicaré tu consulta a nuestro personal.';

    } else if (esOpcion5) {
      // Inicia flujo guiado
      estadosUsuarios[from] = { paso: 'esperandoNombre', datos: {} };
      replyText =
        '🗓️ *Agendar cita en Arte Fotográfico*\n\n' +
        'Perfecto, te ayudo a reservar tu sesión.\n\n' +
        '1️⃣ Para empezar, dime por favor tu *nombre completo*.\n\n' +
        'Si deseas cancelar este proceso escribe "cancelar cita".';

    } else {
      // 🧠 IA con contexto desde servicios.json
      const contexto = construirContextoParaIA(texto);
      replyText = await preguntarAGemini(texto, contexto);
    }

    if (replyText) await sendWhatsAppMessage(from, replyText);
  } catch (err) {
    console.error('⚠️ Error procesando el webhook:', err);
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
