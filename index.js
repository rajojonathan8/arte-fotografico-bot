require('dotenv').config();

const { google } = require('googleapis');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// 🔐 Tokens y claves desde Render
const token = process.env.WHATSAPP_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

// ⚠️ PON AQUÍ TUS DATOS REALES (estos sí van en código)
const VERIFY_TOKEN = 'MI_TOKEN_SECRETO_ARTE_FOTOGRAFICO'; // mismo que usaste en Meta
const PHONE_NUMBER_ID = '805856909285040';

// ---- Google Calendar: service account ----
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
    scopes: ['https://www.googleapis.com/auth/calendar']
  });

  const authClient = await auth.getClient();

  const calendar = google.calendar({
    version: 'v3',
    auth: authClient
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
    const fin = new Date(inicio.getTime() + 30 * 60 * 1000);   // dura 30 minutos

    const evento = {
      summary: `Cita de prueba con ${nombreCliente || 'cliente de WhatsApp'}`,
      description: `Cita creada automáticamente desde el bot de Arte Fotográfico. Teléfono: ${telefono || ''}`,
      start: {
        dateTime: inicio.toISOString(),
        timeZone: 'America/El_Salvador'
      },
      end: {
        dateTime: fin.toISOString(),
        timeZone: 'America/El_Salvador'
      }
    };

    const res = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: evento
    });

    console.log('✅ Evento de prueba creado en Calendar:', res.data.id);
    return true;
  } catch (error) {
    console.error('❌ Error al crear evento de prueba en Calendar:');
    if (error.response) {
      console.error(error.response.data);
    } else {
      console.error(error.message);
    }
    return false;
  }
}

async function crearCitaEnCalendar(fechaHoraTexto, tipoSesion, telefono) {
  try {
    console.log('💠 crearCitaEnCalendar =>', { fechaHoraTexto, tipoSesion, telefono });

    const calendar = await getCalendarClient();
    if (!calendar) {
      console.log('💠 Calendar debug: getCalendarClient() devolvió null en crearCitaEnCalendar');
      return false;
    }
    if (!GOOGLE_CALENDAR_ID) {
      console.log('💠 Calendar debug: Falta GOOGLE_CALENDAR_ID en crearCitaEnCalendar');
      return false;
    }

    // Esperamos formato: "YYYY-MM-DD HH:mm"
    const [fechaStr, horaStr] = fechaHoraTexto.split(' ');
    if (!fechaStr || !horaStr) {
      console.log('💠 Fecha/hora con formato inválido:', fechaHoraTexto);
      return false;
    }

    const [anio, mes, dia] = fechaStr.split('-').map(Number);
    const [hora, minuto] = horaStr.split(':').map(Number);

    // Mes en JS es 0-based (enero=0)
    const inicio = new Date(Date.UTC(anio, mes - 1, dia, hora, minuto));
    const fin = new Date(inicio.getTime() + 60 * 60 * 1000); // duración 1h

    const evento = {
      summary: `Sesión ${tipoSesion || 'fotográfica'} - Cliente WhatsApp`,
      description: `Sesión agendada desde el bot de Arte Fotográfico.\nTeléfono: ${telefono || ''}`,
      start: {
        dateTime: inicio.toISOString(),
        timeZone: 'America/El_Salvador'
      },
      end: {
        dateTime: fin.toISOString(),
        timeZone: 'America/El_Salvador'
      }
    };

    const res = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: evento
    });

    console.log('✅ Cita creada en Calendar:', res.data.id);
    return true;
  } catch (error) {
    console.error('❌ Error al crear cita en Calendar:');
    if (error.response && error.response.data) {
      console.error(JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
    return false;
  }
}

// 🕓 Horarios
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

// ---- IA: Gemini ----
async function preguntarAGemini(mensajeUsuario) {
  if (!GEMINI_API_KEY) {
    console.error('⚠️ No hay GEMINI_API_KEY configurada');
    return 'Por el momento no puedo usar la IA gratuita, pero con gusto te atiendo como asistente básico de Arte Fotográfico. 😊';
  }

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' +
    GEMINI_API_KEY;

  try {
    const response = await axios.post(url, {
      contents: [
        {
          parts: [
            {
              text:
                'Eres el Asistente Arte Fotográfico. Eres amable, profesional, claro y ordenado. ' +
                'Atiendes a clientes de un estudio fotográfico en Sonsonate, El Salvador. ' +
                'Respondes siempre en español, de forma breve y útil.\n\n' +
                'Mensaje del cliente: ' +
                mensajeUsuario
            }
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
    if (error.response) {
      console.error(error.response.data);
    } else {
      console.error(error.message);
    }
    return 'Ocurrió un problema al usar la IA gratuita (Gemini). Por favor, intenta de nuevo más tarde.';
  }
}

// ---- IA: ChatGPT (opcional) ----
async function preguntarAChatGPT(mensajeUsuario) {
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
              'Eres el Asistente Arte Fotográfico. Eres amable, profesional, claro y ordenado. ' +
              'Atiendes a clientes de un estudio fotográfico en Sonsonate, El Salvador. ' +
              'Respondes siempre en español, de forma breve y útil.'
          },
          {
            role: 'user',
            content: mensajeUsuario
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`
        }
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
    if (error.response) {
      console.error(error.response.data);
    } else {
      console.error(error.message);
    }
    return 'Ocurrió un problema al usar la IA en este momento. Por favor, intenta de nuevo más tarde.';
  }
}

app.use(bodyParser.json());

// Ruta simple de prueba
app.get('/', (req, res) => {
  res.send('Servidor Arte Fotográfico activo 🚀');
});

// ✅ WEBHOOK DE VERIFICACIÓN (GET)
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

// ✅ FUNCIÓN PARA ENVIAR MENSAJES DE WHATSAPP
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

  try {
    const response = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to,
        text: { body: text }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      }
    );

    console.log('✅ Mensaje enviado a WhatsApp:', response.data);
  } catch (error) {
    console.error('❌ Error al enviar mensaje a WhatsApp:');
    if (error.response) {
      console.error(error.response.data);
    } else {
      console.error(error.message);
    }
  }
}

// ✅ WEBHOOK PARA RECIBIR MENSAJES (POST)
app.post('/webhook', async (req, res) => {
  console.log('📩 Webhook recibido:');
  console.dir(req.body, { depth: null });

  try {
    const entry = req.body.entry && req.body.entry[0];
    const changes = entry && entry.changes && entry.changes[0];
    const value = changes && changes.value;
    const messages = value && value.messages;

    if (messages && messages[0]) {
      const message = messages[0];

      const from = message.from; // número del cliente
      const msgBody = message.text && message.text.body ? message.text.body : '';

      console.log(`📨 Mensaje de ${from}: ${msgBody}`);

      const texto = msgBody.trim();
      const textoLower = texto.toLowerCase();

      // 🕓 Si el mensaje llega fuera de horario
      if (!esHorarioLaboral()) {
        let mensajeRespuesta = '';

        if (esDomingo()) {
          // 🌞 Mensaje especial solo para domingos
          mensajeRespuesta =
            '📸 *¡Gracias por contactarnos con Arte Fotográfico!* 💬\n\n' +
            'Hoy es *domingo* y nuestro estudio se encuentra *cerrado* por descanso del personal. 🛌\n\n' +
            '🕓 *Nuestro horario de atención es:*\n' +
            '👉 *Lunes a viernes:* de 8:00 a.m. a 12:30 p.m. y de 2:00 p.m. a 6:00 p.m.\n' +
            '👉 *Sábados:* de 8:00 a.m. a 12:30 p.m.\n\n' +
            'Puedes dejar tu mensaje con toda confianza y el lunes te responderemos en horario de atención. 😊';
        } else {
          // ⏰ Fuera de horario normal (entre semana o sábado fuera de hora)
          mensajeRespuesta =
            '📸 *¡Gracias por contactarnos con Arte Fotográfico!* 💬\n\n' +
            'En este momento estamos *fuera de nuestro horario de atención*, pero con gusto te responderemos en cuanto estemos de vuelta. 😊\n\n' +
            '🕓 *Nuestro horario de atención es:*\n' +
            '👉 *Lunes a viernes:* de 8:00 a.m. a 12:30 p.m. y de 2:00 p.m. a 6:00 p.m.\n' +
            '👉 *Sábados:* de 8:00 a.m. a 12:30 p.m.\n' +
            '📍 *Sonsonate, El Salvador.*\n\n' +
            '¡Gracias por tu mensaje y por elegirnos para capturar tus mejores momentos! 📷💖';
        }

        await sendWhatsAppMessage(from, mensajeRespuesta);
        return res.sendStatus(200); // no seguimos procesando más lógica
      }

      const esTestCalendar = textoLower === 'test calendar';
      const esComandoCita = textoLower.startsWith('cita:');

      // 👋 Detectar saludos básicos
      const esSaludo =
        textoLower.includes('hola') ||
        textoLower.includes('hola mario') ||
        textoLower.includes('hola marito') ||
        textoLower.includes('buenos dias') ||
        textoLower.includes('buenos días') ||
        textoLower.includes('buenas tardes') ||
        textoLower.includes('buenas noches') ||
        textoLower.includes('hey') ||
        textoLower.includes('qué tal') ||
        textoLower.includes('que tal');

      // Prefijo para forzar modo IA
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

      if (usaIAForzado) {
        const pregunta = texto.substring(3).trim() || 'Responde como asistente de Arte Fotográfico.';
        console.log('🤖 Enviando a Gemini (modo ia:):', pregunta);
        replyText = await preguntarAGemini(pregunta);

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
        const sinPrefijo = texto.substring(5).trim(); // quita "cita:"
        const partes = sinPrefijo.split(';').map(p => p.trim());

        const fechaHoraTexto = partes[0];
        const tipoSesion = partes[1] || 'fotográfica';
        const telefonoCliente = partes[2] || from;

        if (!fechaHoraTexto) {
          replyText =
            '⚠️ Formato de cita inválido.\n' +
            'Usa por ejemplo:\n' +
            'cita: 2025-11-15 15:00; sesión familiar; 50370000000';
        } else {
          const ok = await crearCitaEnCalendar(fechaHoraTexto, tipoSesion, telefonoCliente);
          if (ok) {
            replyText =
              '✅ He creado tu cita en el calendario de Arte Fotográfico.\n' +
              `📅 Fecha y hora: *${fechaHoraTexto}*\n` +
              `📸 Tipo de sesión: *${tipoSesion}*\n` +
              `📞 Contacto: *${telefonoCliente}*`;
          } else {
            replyText =
              '❌ Ocurrió un problema al crear la cita en el calendario.\n' +
              'Por favor revisa el formato y vuelve a intentarlo, o avisa a un colaborador.';
          }
        }

      } else if (esTestCalendar) {
        const ok = await crearEventoDePruebaCalendar('Cliente de prueba', from);
        if (ok) {
          replyText =
            '✅ He creado un *evento de prueba* en el calendario de Arte Fotográfico para dentro de 1 hora.\n' +
            'Por favor revisa tu Google Calendar para verificarlo. 🗓️';
        } else {
          replyText =
            '❌ No pude crear el evento de prueba en el calendario.\n' +
            'Revisa las credenciales de Google y vuelve a intentarlo.';
        }

      } else if (esOpcion1) {
        replyText =
          '📷 *SERVICIO FOTO ESTUDIO*\n\n' +
          'En Foto Estudio ofrecemos:\n\n' +
          '🔸 *Fotografías para títulos y documentos:*\n' +
          '- Título de Bachiller\n' +
          '- Título Universitario 7x9 (Uso Universidad de Sonsonate)\n' +
          '- Título Universitario 6x8 (UMA Universidad Modular Abierta)\n' +
          '- Certificados, Escalafón, Carnets y más.\n\n' +
          '🔸 *Fotografías para servicios migratorios:*\n' +
          '- VISA Americana (2x2 / 50x50 mm) — 💲10.00\n' +
          '- VISA Canadiense (3.5x4.5 cm) — 💲10.00\n' +
          '- VISA Mexicana (3.2x2.6 cm) — 💲10.00\n' +
          '(Todas incluyen 4 fotografías impresas)\n\n' +
          '🔸 *Sesiones fotográficas:*\n' +
          '- Personales, de pareja, familiares, bebés, portafolio profesional, graduados, navideñas y más 🎉\n' +
          '(Precios disponibles directamente en el local)\n\n' +
          '🔸 *Retratos especiales:*\n' +
          '- Blanco y negro, contemporáneos y artísticos.\n\n' +
          'Si deseas más información o agendar tu sesión, dime y con gusto te ayudo 😊';

      } else if (esOpcion2) {
        replyText =
          '💍 *COTIZACIÓN DE PAQUETES DE EVENTOS SOCIALES*\n\n' +
          'En Arte Fotográfico tenemos paquetes personalizados para:\n' +
          '- Bodas\n' +
          '- 15 años\n' +
          '- Bautizos\n' +
          '- Comuniones\n' +
          '- Baby showers\n' +
          '- Fiestas infantiles\n' +
          '- Sesiones pre 15 años\n' +
          '- Sesiones en exteriores (outdoors)\n\n' +
          '👉 Para brindarte una cotización personalizada, por favor dime:\n' +
          '- Tipo de evento\n' +
          '- Fecha del evento\n' +
          '- Lugar (salón, iglesia, casa, ciudad, etc.)\n\n' +
          'Si prefieres hablar con una persona, también puedo comunicarte con nuestro personal 📞';

      } else if (esOpcion3) {
        replyText =
          '🖨️ *SERVICIO DE IMPRESIÓN FOTOGRÁFICA*\n\n' +
          'Ofrecemos impresiones fotográficas de alta calidad en diferentes tamaños y acabados.\n\n' +
          'Puedes enviarnos tus fotos de estas formas:\n' +
          '- 📁 Desde USB\n' +
          '- 📱 Enviándolas por WhatsApp\n' +
          '- ✉️ Desde tu correo electrónico\n\n' +
          'Si deseas cotizar o hacer un pedido, puedo comunicarte con nuestro personal para ayudarte con tamaños, precios y tiempos de entrega. 😊\n\n' +
          '¿Te gustaría que te atienda un colaborador para tu impresión fotográfica?';

      } else if (esOpcion4) {
        replyText =
          '📦 *CONSULTAR ORDEN*\n\n' +
          'Para ayudarte a consultar el estado de tu orden, por favor envíame uno de estos datos:\n' +
          '- Número de orden (si lo tienes)\n' +
          'o\n' +
          '- Nombre completo con el que hiciste el pedido\n\n' +
          'Con esa información, comunicaré tu consulta a nuestro personal para que te brinden el estado actualizado de tu pedido. 😊';

      } else if (esOpcion5) {
        replyText =
          '🗓️ *AGENDA TU CITA*\n\n' +
          'Con gusto podemos ayudarte a agendar una sesión o cita en Arte Fotográfico.\n\n' +
          'Por favor envíame estos datos:\n' +
          '- 📅 Fecha deseada\n' +
          '- 📷 Tipo de sesión (por ejemplo: título, familiar, pareja, bebé, graduación, etc.)\n' +
          '- 📞 Número de contacto\n\n' +
          'Con esa información, comunicaré tu solicitud a uno de nuestros colaboradores para confirmar disponibilidad y horarios contigo. 😊';

      } else {
        const pregunta =
          'Cliente de Arte Fotográfico dice: "' +
          texto +
          '". Responde como asistente del estudio fotográfico en Sonsonate. ' +
          'Sé amable, profesional, breve (máximo 3 líneas) y en español. ' +
          'Si la pregunta tiene que ver con horarios, dirección, servicios o paquetes, respóndelo claramente. ' +
          'Si no entiendes, pide al cliente que aclare su duda.';

        console.log('🤖 Enviando a Gemini (modo automático):', pregunta);
        replyText = await preguntarAGemini(pregunta);
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
