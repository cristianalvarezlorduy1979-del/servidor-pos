const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.json')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const API_KEY = "sr11_secret_token_2026";
const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'restaurants_cache.json');

// Almacen multicliente persistente en disco
let restaurantsData = {};
try {
  if (fs.existsSync(DATA_FILE)) {
    restaurantsData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log('[CACHE DISCO] Datos de restaurantes restaurados exitosamente.');
  }
} catch (e) {
  console.log('[CACHE DISCO] Error leyendo cache:', e);
}

function saveCache() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(restaurantsData, null, 2), 'utf8');
  } catch (e) {
    console.log('[CACHE DISCO] Error guardando cache:', e);
  }
}

function getDefaultData(restaurantId = "rest_001", name = "Soft Restaurant 11") {
  return {
    timestamp: new Date().toISOString(),
    restaurant_id: restaurantId,
    restaurant_name: name,
    status: "offline",
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
    ultimas_cuentas: [],
    ayer: {
      total_ventas: 0,
      cuentas_cobradas: 0,
      ticket_promedio: 0,
      total_propinas: 0,
      formas_pago: []
    }
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
  
  // Si los datos previos tenian 'ayer' y el nuevo no lo trae, preservarlo
  const prevAyer = restaurantsData[restaurantId]?.ayer;
  const newAyer = req.body.ayer && req.body.ayer.total_ventas > 0 ? req.body.ayer : (prevAyer || req.body.ayer);

  restaurantsData[restaurantId] = {
    ...req.body,
    restaurant_id: restaurantId,
    ayer: newAyer,
    status: "online",
    last_received: new Date().toISOString()
  };

  saveCache();

  const payload = restaurantsData[restaurantId];

  // Emitir unicamenta a los telefonos que estan viendo este restaurante especifico
  io.to(restaurantId).emit('pos_update', payload);
  io.emit(`pos_update_${restaurantId}`, payload);

  console.log(`[SYNC RECIBIDO] [${restaurantId.toUpperCase()}] ${payload.restaurant_name} | Total: $${payload.resumen.total_ventas.toFixed(2)} | Cobradas: ${payload.resumen.cuentas_cobradas}`);
  res.json({ success: true, message: `Datos del restaurante ${restaurantId} actualizados` });
});

// Endpoint para consultar datos iniciales de un restaurante especifico
app.get('/api/pos/stats', (req, res) => {
  const restaurantId = (req.query.restaurant_id || req.query.id || 'rest_001').toLowerCase().trim();
  const raw = restaurantsData[restaurantId] || getDefaultData(restaurantId, `Restaurante ${restaurantId}`);
  
  // Determinar si la PC esta online o apagada
  const now = new Date();
  const last = raw.last_received ? new Date(raw.last_received) : null;
  const isOnline = last && ((now - last) / 1000) < 60; // recibido hace menos de 60s
  
  const data = {
    ...raw,
    status: isOnline ? "online" : "offline"
  };
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
