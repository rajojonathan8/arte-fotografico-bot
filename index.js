require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function preguntarAChatGPT(mensajeUsuario) {
  if (!OPENAI_API_KEY) {
    console.error('⚠️ No hay OPENAI_API_KEY configurada');
    return 'Por el momento no puedo usar inteligencia artificial, pero con gusto te atiendo como asistente básico de Arte Fotográfico. 😊';
  }

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4.1-mini',
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


// ⚠️ PON AQUÍ TUS DATOS REALES
const VERIFY_TOKEN = 'MI_TOKEN_SECRETO_ARTE_FOTOGRAFICO'; // mismo que usaste en Meta
const WHATSAPP_TOKEN = 'EAFoXrBcgNOoBP92qdpZCkPLZCzJTxZAQ3Ty76WyHbjO5fuDZBZBbRXVZALVLQeVMkYnRxsEZBs86xBb6ySt06uMiFVVTdfek82shGiEq9JxGwh9lFEVLKJu2ZCEk3J6v5UM1aRUlhry1mkMmGz9e1r2YVKbZA8B2DESzhBWGSpIZA7AOKJjmhdfSERWWNlkOFhgkuoWPfpznm9jFfopAM6EY6yPVV9D1MPboBrzuZBeMvZAOrJQzCuIFL9Wr587I9fXTZArJOdiXAZCeFaQ57Mm3fbzj64oqsbgg9JJ7utg3w3'; // EAAG...
const PHONE_NUMBER_ID = '805856909285040';       // p.ej. 123456789012345

app.use(bodyParser.json());

// Ruta simple de prueba
app.get('/', (req, res) => {
  res.send('Servidor Arte Fotográfico activo 🚀');
});

// ✅ WEBHOOK DE VERIFICACIÓN (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
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
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
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

      // 🔹 RESPUESTA BÁSICA (luego la cambiamos por la lógica de Arte Fotográfico)
           const texto = msgBody.trim();
      const textoLower = texto.toLowerCase();

      // 👋 Detectar saludos básicos
      const esSaludo =
        textoLower.includes('hola') ||
        textoLower.includes('buenos dias') ||
        textoLower.includes('buenos días') ||
        textoLower.includes('buenas tardes') ||
        textoLower.includes('buenas noches') ||
        textoLower.includes('hey') ||
        textoLower.includes('qué tal') ||
        textoLower.includes('que tal');

      const usaIA = textoLower.startsWith('ia:');

      let replyText = '';

      if (usaIA) {
        const pregunta = texto.substring(3).trim() || 'Responde como asistente de Arte Fotográfico.';
        console.log('🤖 Enviando a ChatGPT la pregunta:', pregunta);
        replyText = await preguntarAChatGPT(pregunta);
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
      } else {
        // Respuesta genérica por ahora
        replyText =
          '👋 ¡Hola! Gracias por escribir a Arte Fotográfico 📸.\n' +
          'Por favor selecciona una opción del menú principal enviando un número del 1 al 5.\n\n' +
          'Si quieres probar el modo IA, puedes escribir por ejemplo:\n' +
          'ia: dame ideas para una sesión de fotos familiares.';
      }

      await sendWhatsAppMessage(from, replyText);

    }
  } catch (err) {
    console.error('⚠️ Error procesando el webhook:', err);
  }

  // Meta siempre espera 200 rápido
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
