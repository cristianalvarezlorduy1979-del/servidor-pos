const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Habilitar CORS para permitir conexion desde la app movil y web
app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const API_KEY = "sr11_secret_token_2026";
const PORT = process.env.PORT || 3001;

// Estado en memoria de las ventas del restaurante
let currentPosData = {
  timestamp: new Date().toISOString(),
  restaurant_name: "Soft Restaurant 11",
  status: "waiting_agent",
  resumen: {
    total_ventas: 0,
    cuentas_cobradas: 0,
    ticket_promedio: 0,
    total_propinas: 0,
    total_descuentos: 0
  },
  cuentas_abiertas: {
    cantidad: 0,
    monto: 0
  },
  formas_pago: [],
  ventas_por_hora: [],
  ultimas_cuentas: []
};

// Middleware de autenticacion para el agente POS
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: "Token de autorizacion invalido" });
  }
  next();
};

// Endpoint que recibe la informacion del Agente Python
app.post('/api/pos/sync', authMiddleware, (req, res) => {
  currentPosData = {
    ...req.body,
    last_received: new Date().toISOString()
  };

  // Notificar a todos los dispositivos moviles conectados por WebSockets
  io.emit('pos_update', currentPosData);

  console.log(`[SYNC RECIBIDO] Total hoy: $${currentPosData.resumen.total_ventas.toFixed(2)} | Cobradas: ${currentPosData.resumen.cuentas_cobradas} | Notificados ${io.engine.clientsCount} clientes moviles.`);
  res.json({ success: true, message: "Datos actualizados y emitidos en tiempo real" });
});

// Endpoint para que la app movil consulte el estado actual de inmediato al abrirse
app.get('/api/pos/stats', (req, res) => {
  res.json(currentPosData);
});

// Endpoint para generar datos de prueba si no hay ventas hoy en el restaurante
app.post('/api/pos/simulate', (req, res) => {
  const horaActual = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  const nuevoMonto = Math.floor(Math.random() * (950 - 150 + 1)) + 150;
  const propina = Math.round(nuevoMonto * 0.10);
  
  currentPosData.resumen.total_ventas += nuevoMonto;
  currentPosData.resumen.cuentas_cobradas += 1;
  currentPosData.resumen.ticket_promedio = currentPosData.resumen.total_ventas / currentPosData.resumen.cuentas_cobradas;
  currentPosData.resumen.total_propinas += propina;
  
  const metodoAleatorio = Math.random() > 0.5 ? 'TARJETA VISA' : 'EFECTIVO';
  let metodoObj = currentPosData.formas_pago.find(f => f.metodo === metodoAleatorio);
  if (!metodoObj) {
    metodoObj = { metodo: metodoAleatorio, total: 0, transacciones: 0 };
    currentPosData.formas_pago.push(metodoObj);
  }
  metodoObj.total += nuevoMonto;
  metodoObj.transacciones += 1;

  currentPosData.ultimas_cuentas.unshift({
    folio: Math.floor(1000 + Math.random() * 9000),
    numcheque: Math.floor(100 + Math.random() * 900),
    mesa: `Mesa ${Math.floor(1 + Math.random() * 15)}`,
    total: nuevoMonto,
    propina: propina,
    hora: horaActual
  });

  if (currentPosData.ultimas_cuentas.length > 10) {
    currentPosData.ultimas_cuentas.pop();
  }

  currentPosData.timestamp = new Date().toISOString();
  currentPosData.status = "online_simulado";

  io.emit('pos_update', currentPosData);
  console.log(`[SIMULACION] Venta simulada: $${nuevoMonto} - Notificado a la app`);
  res.json({ success: true, data: currentPosData });
});

// Eventos de conexion WebSockets
io.on('connection', (socket) => {
  console.log(`[CLIENTE CONECTADO] ID: ${socket.id} (Total conectados: ${io.engine.clientsCount})`);
  // Enviar de inmediato los datos actuales al cliente que se acaba de conectar
  socket.emit('pos_update', currentPosData);

  socket.on('disconnect', () => {
    console.log(`[CLIENTE DESCONECTADO] ID: ${socket.id}`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(` Servidor Realtime POS escuchando en puerto ${PORT}`);
  console.log(` Red local: http://192.168.0.101:${PORT}`);
  console.log(` Localhost: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
