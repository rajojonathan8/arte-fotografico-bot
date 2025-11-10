const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ⚠️ PON AQUÍ TUS DATOS REALES
const VERIFY_TOKEN = 'MI_TOKEN_SECRETO_ARTE_FOTOGRAFICO'; // mismo que usaste en Meta
const WHATSAPP_TOKEN = 'EAFoXrBcgNOoBPZBo23L5zVchlD7xEmHraILIYZByLAiTdrEfr44Jy0HF8CLLp2ZAZA10uOZAWbQkhYwZCpKmm3kU4oFpFTa7gFBLOM9l4WF8HN70iebNB0ZAM7gZCkf9Svv2YG3TWaKLDVuN5gy5yWYTaJmCftNux90BoUh5mttKknNgzAWDRFrPEiS1nwFkZCN8YhBftJKRbZCLVBao7FU1oYpM8hiJSm5zi8tDJeH4AjZALNWe67IG3S3U7MfUYqgD5Vo7KSAjzf55c15sXAOv622Dk3oSHPz8rhVUHAZD'; // EAAG...
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
      const replyText = '👋 ¡Hola! Gracias por escribir a Arte Fotográfico 📸. Este es un mensaje de prueba automático.';

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
