// Datos de prueba por ahora (más adelante lo conectamos al backend)
const contactosDemo = [
  {
    id: '50370000001',
    nombre: 'Cliente VISA USA',
    telefono: '+503 7000-0001',
    ultimo: 'Consulta sobre fotos para visa americana',
  },
  {
    id: '50370000002',
    nombre: 'María – Título Bachiller',
    telefono: '+503 7000-0002',
    ultimo: 'Precio y vestimenta para título',
  },
  {
    id: '50370000003',
    nombre: 'Institución Colegio Sonsonate',
    telefono: 'Institución',
    ultimo: 'Paquete fotos graduación',
  },
];

const mensajesDemo = {
  '50370000001': [
    { from: 'cliente', text: 'Hola, quisiera información de fotos para visa americana.', hora: '09:15' },
    { from: 'yo', text: 'Con gusto, el paquete de visa americana tiene un costo de $10 e incluye 4 fotos.', hora: '09:16' },
    { from: 'cliente', text: '¿Qué ropa recomienda?', hora: '09:17' },
  ],
  '50370000002': [
    { from: 'cliente', text: 'Buenas, necesito fotos para título de bachiller.', hora: '10:02' },
    { from: 'yo', text: 'Perfecto, el servicio cuesta $10 e incluye asesoría de vestuario.', hora: '10:04' },
  ],
  '50370000003': [
    { from: 'cliente', text: 'Somos el Colegio Sonsonate, cotización para graduación.', hora: '11:20' },
  ],
};

let contactoActivo = null;

function $(sel) {
  return document.querySelector(sel);
}

function crearElemento(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => c && el.appendChild(c));
  return el;
}

function renderContactos() {
  const ul = $('#contactList');
  ul.innerHTML = '';
  contactosDemo.forEach((c) => {
    const li = crearElemento('li', {
      class: `contact-item ${contactoActivo === c.id ? 'active' : ''}`,
      'data-id': c.id,
    }, [
      crearElemento('div', { class: 'contact-name', text: c.nombre }),
      crearElemento('div', { class: 'contact-phone', text: c.telefono }),
      crearElemento('div', { class: 'contact-lastmsg', text: c.ultimo }),
    ]);
    li.addEventListener('click', () => seleccionarContacto(c.id));
    ul.appendChild(li);
  });
}

function renderMensajes() {
  const cont = $('#chatMessages');
  cont.innerHTML = '';

  if (!contactoActivo) {
    cont.innerHTML = '<div class="chat-placeholder">Selecciona una conversación en la izquierda.</div>';
    return;
  }

  const lista = mensajesDemo[contactoActivo] || [];
  if (!lista.length) {
    cont.innerHTML = '<div class="chat-placeholder">No hay mensajes todavía con este cliente.</div>';
    return;
  }

  lista.forEach((m) => {
    const row = crearElemento('div', { class: `msg-row ${m.from === 'yo' ? 'me' : 'client'}` });
    const bubble = crearElemento('div', {
      class: `msg-bubble ${m.from === 'yo' ? 'msg-me' : 'msg-client'}`,
    }, [
      crearElemento('div', { text: m.text }),
      crearElemento('div', { class: 'msg-meta', text: m.hora || '' }),
    ]);
    row.appendChild(bubble);
    cont.appendChild(row);
  });

  cont.scrollTop = cont.scrollHeight;
}

function seleccionarContacto(id) {
  contactoActivo = id;
  const c = contactosDemo.find((x) => x.id === id);
  $('#chatContactName').textContent = c ? c.nombre : 'Cliente';
  $('#chatContactPhone').textContent = c ? c.telefono : '';
  renderContactos();
  renderMensajes();
}

function manejarEnvioMensaje(e) {
  e.preventDefault();
  const input = $('#chatInput');
  const texto = input.value.trim();
  if (!texto || !contactoActivo) return;

  const ahora = new Date();
  const hh = String(ahora.getHours()).padStart(2, '0');
  const mm = String(ahora.getMinutes()).padStart(2, '0');

  if (!mensajesDemo[contactoActivo]) mensajesDemo[contactoActivo] = [];
  mensajesDemo[contactoActivo].push({ from: 'yo', text: texto, hora: `${hh}:${mm}` });

  const c = contactosDemo.find((x) => x.id === contactoActivo);
  if (c) c.ultimo = texto;

  input.value = '';
  renderContactos();
  renderMensajes();

  // Más adelante: aquí llamaremos a una ruta del backend para enviar el mensaje real por WhatsApp.
}

document.addEventListener('DOMContentLoaded', () => {
  renderContactos();
  renderMensajes();
  const form = $('#chatForm');
  if (form) form.addEventListener('submit', manejarEnvioMensaje);

  if (contactosDemo.length) {
    seleccionarContacto(contactosDemo[0].id);
  }
});
