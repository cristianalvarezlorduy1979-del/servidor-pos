const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const API_KEY = "sr11_secret_token_2026";
const PORT = process.env.PORT || 3001;

// Almacen multicliente: cada restaurante tiene su propia clave (restaurant_id)
const restaurantsData = {};

function getDefaultData(restaurantId = "rest_001", name = "Soft Restaurant 11") {
  return {
    timestamp: new Date().toISOString(),
    restaurant_id: restaurantId,
    restaurant_name: name,
    status: "online",
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
}

// Middleware de autenticacion
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: "Token de autorizacion invalido" });
  }
  next();
};

// Endpoint que recibe la sincronizacion desde cualquier restaurante
app.post('/api/pos/sync', authMiddleware, (req, res) => {
  const restaurantId = (req.body.restaurant_id || 'rest_001').toLowerCase().trim();
  
  restaurantsData[restaurantId] = {
    ...req.body,
    restaurant_id: restaurantId,
    last_received: new Date().toISOString()
  };

  const payload = restaurantsData[restaurantId];

  // Emitir unicamenta a los telefonos que estan viendo este restaurante especifico
  io.to(restaurantId).emit('pos_update', payload);
  io.emit(`pos_update_${restaurantId}`, payload);

  console.log(`[SYNC RECIBIDO] [${restaurantId.toUpperCase()}] ${payload.restaurant_name} | Total: $${payload.resumen.total_ventas.toFixed(2)} | Cobradas: ${payload.resumen.cuentas_cobradas}`);
  res.json({ success: true, message: `Datos del restaurante ${restaurantId} actualizados` });
});

// Endpoint para consultar datos iniciales de un restaurante especifico
// Ejemplo: /api/pos/stats?restaurant_id=pizzeria_napoles
app.get('/api/pos/stats', (req, res) => {
  const restaurantId = (req.query.restaurant_id || req.query.id || 'rest_001').toLowerCase().trim();
  const data = restaurantsData[restaurantId] || getDefaultData(restaurantId, `Restaurante ${restaurantId}`);
  res.json(data);
});

// Endpoint para listar restaurantes activos (util para administracion)
app.get('/api/pos/restaurants', (req, res) => {
  const list = Object.keys(restaurantsData).map(id => ({
    id: id,
    name: restaurantsData[id].restaurant_name,
    last_received: restaurantsData[id].last_received,
    total_ventas: restaurantsData[id].resumen.total_ventas
  }));
  res.json(list);
});

// Manejo de conexiones WebSockets por sala privada
io.on('connection', (socket) => {
  console.log(`[CLIENTE CONECTADO] Socket ID: ${socket.id}`);

  // El telefono se une a la sala de su restaurante
  socket.on('join_restaurant', (restaurantId) => {
    if (!restaurantId) restaurantId = 'rest_001';
    restaurantId = restaurantId.toLowerCase().trim();
    
    socket.join(restaurantId);
    console.log(`[SALA ASIGNADA] Socket ${socket.id} se unio al restaurante: ${restaurantId}`);

    // Enviarle de inmediato los datos de ese restaurante
    const data = restaurantsData[restaurantId] || getDefaultData(restaurantId, `Restaurante ${restaurantId}`);
    socket.emit('pos_update', data);
  });

  socket.on('disconnect', () => {
    console.log(`[CLIENTE DESCONECTADO] Socket ID: ${socket.id}`);
  });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const indexPath = path.join(__dirname, 'public', 'index.html');
  res.sendFile(indexPath);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(` Servidor Multi-Restaurante POS escuchando en puerto ${PORT}`);
  console.log(`=======================================================`);
});
