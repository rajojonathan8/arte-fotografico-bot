const express = require('express');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Para poder leer JSON del cuerpo de las peticiones
app.use(bodyParser.json());

// Ruta simple de prueba
app.get('/', (req, res) => {
  res.send('Servidor Arte Fotográfico activo 🚀');
});

// ✅ WEBHOOK DE VERIFICACIÓN (GET)
// Meta llamará a esta ruta cuando configures el webhook
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = 'MI_TOKEN_SECRETO_ARTE_FOTOGRAFICO'; // puedes cambiarlo

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

// ✅ WEBHOOK PARA RECIBIR MENSAJES (POST)
app.post('/webhook', (req, res) => {
  console.log('📩 Webhook recibido:');
  console.dir(req.body, { depth: null });

  // IMPORTANTE: Siempre responder 200 a Meta rápido
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
