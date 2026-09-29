const express = require('express');
const http = require('http');
const https = require('https');
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
const FIRESTORE_PROJECT = "dcasesorias-col";

// Almacén multicliente en memoria
let restaurantsData = {};

// 1. Cargar caché de disco local si existe
try {
  if (fs.existsSync(DATA_FILE)) {
    restaurantsData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log('[CACHE DISCO] Restaurados restaurantes desde disco local.');
  }
} catch (e) {
  console.log('[CACHE DISCO] Error leyendo cache disco:', e.message);
}

function saveCache() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(restaurantsData, null, 2), 'utf8');
  } catch (e) {
    console.log('[CACHE DISCO] Error guardando cache disco:', e.message);
  }
}

// 2. Persistencia en la nube (Firebase Firestore)
// Esto sobrevive a los reinicios y suspensión (sleep) de Render.com sin costo alguno
function saveToFirestore(restaurantId, data) {
  return new Promise((resolve) => {
    try {
      const payloadStr = JSON.stringify(data);
      const body = JSON.stringify({
        fields: {
          payload: { stringValue: payloadStr },
          restaurant_name: { stringValue: data.restaurant_name || '' },
          total_ventas: { doubleValue: data.resumen?.total_ventas || 0 },
          total_ayer: { doubleValue: data.ayer?.total_ventas || 0 },
          updated_at: { stringValue: new Date().toISOString() }
        }
      });

      const req = https.request({
        hostname: 'firestore.googleapis.com',
        path: `/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/pos_cache/${encodeURIComponent(restaurantId)}`,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let respData = '';
        res.on('data', chunk => respData += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            console.log(`[NUBE FIRESTORE] Guardado exitoso de ${restaurantId.toUpperCase()}`);
          }
          resolve(res.statusCode === 200);
        });
      });

      req.on('error', (err) => {
        console.log('[NUBE FIRESTORE] Error de red al guardar:', err.message);
        resolve(false);
      });
      req.setTimeout(8000, () => {
        req.destroy();
        resolve(false);
      });
      req.write(body);
      req.end();
    } catch (err) {
      console.log('[NUBE FIRESTORE] Excepción al guardar:', err.message);
      resolve(false);
    }
  });
}

function loadFromFirestore(restaurantId) {
  return new Promise((resolve) => {
    try {
      const req = https.get(
        `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/pos_cache/${encodeURIComponent(restaurantId)}`,
        (res) => {
          let respData = '';
          res.on('data', chunk => respData += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(respData);
              if (json.fields?.payload?.stringValue) {
                const parsed = JSON.parse(json.fields.payload.stringValue);
                resolve(parsed);
              } else {
                resolve(null);
              }
            } catch (e) {
              resolve(null);
            }
          });
        }
      );
      req.on('error', () => resolve(null));
      req.setTimeout(8000, () => {
        req.destroy();
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function restoreAllFromFirestore() {
  console.log('[NUBE FIRESTORE] Consultando base de datos persistente en la nube...');
  return new Promise((resolve) => {
    try {
      const req = https.get(
        `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/pos_cache`,
        (res) => {
          let respData = '';
          res.on('data', chunk => respData += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(respData);
              if (json.documents && Array.isArray(json.documents)) {
                let count = 0;
                json.documents.forEach(doc => {
                  try {
                    const id = doc.name.split('/').pop().toLowerCase();
                    if (doc.fields?.payload?.stringValue) {
                      const data = JSON.parse(doc.fields.payload.stringValue);
                      // Solo asignar si la memoria no tiene datos más recientes
                      if (!restaurantsData[id] || (data.timestamp && (!restaurantsData[id].timestamp || data.timestamp > restaurantsData[id].timestamp))) {
                        restaurantsData[id] = data;
                        count++;
                      }
                    }
                  } catch (e) {}
                });
                console.log(`[NUBE FIRESTORE] ¡${count} restaurantes restaurados desde la nube! Datos intactos aunque el PC esté apagado.`);
              }
            } catch (e) {}
            resolve();
          });
        }
      );
      req.on('error', () => resolve());
      req.setTimeout(8000, () => { req.destroy(); resolve(); });
    } catch {
      resolve();
    }
  });
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

// Middleware de autenticación
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: "Token de autorización inválido" });
  }
  next();
};

// Control de debounce para no saturar Firestore
const lastFirestoreSync = {};

// Endpoint que recibe la sincronización desde el agente en el restaurante
app.post('/api/pos/sync', authMiddleware, (req, res) => {
  const restaurantId = (req.body.restaurant_id || 'rest_001').toLowerCase().trim();
  
  // Preservar 'ayer' si los datos nuevos no lo traen o viene en 0
  const prevData = restaurantsData[restaurantId];
  const prevAyer = prevData?.ayer;
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

  // Sincronizar a Firestore en la nube (con debounce de 15 segundos o si cambiaron ventas)
  const now = Date.now();
  const lastSync = lastFirestoreSync[restaurantId] || 0;
  const salesChanged = !prevData || prevData.resumen?.total_ventas !== payload.resumen?.total_ventas;

  if (salesChanged || (now - lastSync > 15000)) {
    lastFirestoreSync[restaurantId] = now;
    saveToFirestore(restaurantId, payload);
  }

  // Emitir por WebSockets a los teléfonos conectados
  io.to(restaurantId).emit('pos_update', payload);
  io.emit(`pos_update_${restaurantId}`, payload);

  console.log(`[SYNC RECIBIDO] [${restaurantId.toUpperCase()}] ${payload.restaurant_name} | Total: $${payload.resumen.total_ventas.toFixed(2)} | Cobradas: ${payload.resumen.cuentas_cobradas}`);
  res.json({ success: true, message: `Datos del restaurante ${restaurantId} actualizados` });
});

// Endpoint para consultar datos iniciales de un restaurante específico
app.get('/api/pos/stats', async (req, res) => {
  const restaurantId = (req.query.restaurant_id || req.query.id || 'rest_001').toLowerCase().trim();
  
  // Si no está en RAM (ej: Render acaba de despertar de suspensión), traerlo de Firestore
  if (!restaurantsData[restaurantId] || (!restaurantsData[restaurantId].resumen?.total_ventas && !restaurantsData[restaurantId].ayer?.total_ventas)) {
    const cloudData = await loadFromFirestore(restaurantId);
    if (cloudData) {
      restaurantsData[restaurantId] = cloudData;
      console.log(`[STATS] Datos de ${restaurantId} recuperados de Firestore para consulta.`);
    }
  }

  const raw = restaurantsData[restaurantId] || getDefaultData(restaurantId, `Restaurante ${restaurantId}`);
  
  // Determinar si la PC está online o apagada
  const now = new Date();
  const last = raw.last_received ? new Date(raw.last_received) : null;
  const isOnline = last && ((now - last) / 1000) < 90; // recibido hace menos de 90 segundos
  
  const data = {
    ...raw,
    status: isOnline ? "online" : "offline"
  };
  res.json(data);
});

// Endpoint para listar restaurantes activos
app.get('/api/pos/restaurants', (req, res) => {
  const list = Object.keys(restaurantsData).map(id => ({
    id: id,
    name: restaurantsData[id].restaurant_name,
    last_received: restaurantsData[id].last_received,
    total_ventas: restaurantsData[id].resumen?.total_ventas || 0,
    ayer_ventas: restaurantsData[id].ayer?.total_ventas || 0
  }));
  res.json(list);
});

// Manejo de conexiones WebSockets
io.on('connection', (socket) => {
  socket.on('join_restaurant', async (restaurantId) => {
    if (!restaurantId) restaurantId = 'rest_001';
    restaurantId = restaurantId.toLowerCase().trim();
    
    socket.join(restaurantId);

    // Si no está en RAM, cargar de Firestore
    if (!restaurantsData[restaurantId]) {
      const cloudData = await loadFromFirestore(restaurantId);
      if (cloudData) restaurantsData[restaurantId] = cloudData;
    }

    const raw = restaurantsData[restaurantId] || getDefaultData(restaurantId, `Restaurante ${restaurantId}`);
    const now = new Date();
    const last = raw.last_received ? new Date(raw.last_received) : null;
    const isOnline = last && ((now - last) / 1000) < 90;

    socket.emit('pos_update', {
      ...raw,
      status: isOnline ? "online" : "offline"
    });
  });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const indexPath = path.join(__dirname, 'public', 'index.html');
  res.sendFile(indexPath);
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`=======================================================`);
  console.log(` Servidor Multi-Restaurante POS escuchando en puerto ${PORT}`);
  console.log(`=======================================================`);
  
  // Restaurar automáticamente la base de datos de todos los restaurantes al iniciar
  await restoreAllFromFirestore();
});
