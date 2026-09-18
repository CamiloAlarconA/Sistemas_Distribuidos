const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================================================
// CONFIGURACIÓN
// =====================================================

const NODE_ID = String(
  process.argv[2] || process.env.NODE_ID || "A"
).trim();

const PORT = Number(
  process.argv[3] || process.env.PORT || 3000
);

const PUBLIC_URL = String(
  process.argv[4] ||
  process.env.PUBLIC_URL ||
  `http://localhost:${PORT}`
).replace(/\/+$/, "");

const MY_URL = PUBLIC_URL;

// =====================================================
// DATOS
// =====================================================

const peers = {};
const workers = {};
const messages = [];
const events = [];

let coordinatorId = NODE_ID;
let electionNumber = 0;
let electionInProgress = false;

// =====================================================
// LOG
// =====================================================

function logEvent(message) {
  const text = `[${new Date().toLocaleTimeString()}] ${message}`;

  console.log(text);

  events.unshift(text);

  if (events.length > 100) {
    events.pop();
  }
}

// =====================================================
// UTILIDADES
// =====================================================

function normalizeUrl(url) {
  if (!url) return null;

  return String(url)
    .trim()
    .replace(/\/+$/, "");
}

function priority(id) {
  const value = String(id).toUpperCase();

  if (/^[A-Z]$/.test(value)) {
    return value.charCodeAt(0);
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  let result = 0;

  for (const char of value) {
    const n = parseInt(char, 36);
    result = result * 36 + (Number.isNaN(n) ? 0 : n);
  }

  return result;
}

function isHigher(a, b) {
  return priority(a) > priority(b);
}

// =====================================================
// PEERS
// =====================================================

function addPeer(id, url, coordinator = false) {
  id = String(id || "").trim();
  url = normalizeUrl(url);

  if (!id || !url) {
    return false;
  }

  // Nunca agregarnos a nosotros mismos
  if (id === NODE_ID) {
    return false;
  }

  const old = peers[id];

  peers[id] = {
    id,
    url,
    lastSeen: Date.now(),
    coordinator: coordinator || id === coordinatorId
  };

  if (!old) {
    logEvent(`Nodo conectado: ${id} -> ${url}`);
  } else {
    old.lastSeen = Date.now();
    old.url = url;
    old.coordinator = coordinator || id === coordinatorId;
  }

  return true;
}

function removePeer(id) {
  if (!peers[id]) {
    return;
  }

  delete peers[id];

  logEvent(`Nodo ${id} eliminado de los peers`);
}

function markCoordinator(id) {
  coordinatorId = id;

  for (const peer of Object.values(peers)) {
    peer.coordinator = peer.id === id;
  }
}

// =====================================================
// PING
// =====================================================

async function pingPeer(id, url) {
  try {
    const response = await axios.get(
      `${normalizeUrl(url)}/election/ping`,
      {
        timeout: 5000,
        headers: {
          "X-Node-ID": NODE_ID,
          "X-Node-URL": MY_URL
        }
      }
    );

    return response.data;
  } catch (error) {
    return null;
  }
}

// =====================================================
// CONECTAR PEER
// =====================================================

async function connectToPeer(id, url) {
  id = String(id || "").trim();
  url = normalizeUrl(url);

  if (!id || !url) {
    throw new Error("ID y URL son obligatorios");
  }

  if (id === NODE_ID) {
    throw new Error("No puedes conectarte contigo mismo");
  }

  logEvent(`Intentando conectar con ${id} -> ${url}`);

  // ---------------------------------------------------
  // 1. VERIFICAR SERVIDOR
  // ---------------------------------------------------

  const ping = await pingPeer(id, url);

  if (!ping) {
    throw new Error(
      `No se pudo contactar al servidor ${id}. Verifica la URL, ngrok y que el servidor esté ejecutándose.`
    );
  }

  // ---------------------------------------------------
  // 2. AGREGAR PEER LOCALMENTE
  // ---------------------------------------------------

  addPeer(
    id,
    url,
    ping.coordinator === id
  );

  // ---------------------------------------------------
  // 3. REGISTRO BIDIRECCIONAL
  // ---------------------------------------------------

  try {
    const response = await axios.post(
      `${url}/register-coordinator`,
      {
        id: NODE_ID,
        url: MY_URL,
        coordinator: coordinatorId
      },
      {
        timeout: 7000
      }
    );

    if (response.data && response.data.coordinator) {
      coordinatorId = response.data.coordinator;
    }

    logEvent(
      `Registro bidireccional realizado: ${NODE_ID} <-> ${id}`
    );
  } catch (error) {
    logEvent(
      `No se pudo completar registro bidireccional con ${id}: ${error.message}`
    );
  }

  // ---------------------------------------------------
  // 4. CONFIRMACIÓN
  // ---------------------------------------------------

  try {
    await axios.post(
      `${url}/election/ping`,
      {
        id: NODE_ID,
        url: MY_URL,
        coordinator: coordinatorId
      },
      {
        timeout: 5000
      }
    );
  } catch (error) {
    logEvent(
      `No se pudo confirmar conexión con ${id}`
    );
  }

  // ---------------------------------------------------
  // 5. CONSULTAR ESTADO REMOTO
  // ---------------------------------------------------

  try {
    const state = await axios.get(
      `${url}/election/state`,
      {
        timeout: 5000
      }
    );

    if (state.data) {
      if (state.data.coordinator) {
        coordinatorId = state.data.coordinator;
      }

      // Importar peers conocidos por el servidor remoto
      if (Array.isArray(state.data.peers)) {
        for (const remotePeer of state.data.peers) {
          if (
            remotePeer.id &&
            remotePeer.url &&
            remotePeer.id !== NODE_ID
          ) {
            addPeer(
              remotePeer.id,
              remotePeer.url,
              remotePeer.id === state.data.coordinator
            );
          }
        }
      }
    }
  } catch (error) {
    logEvent(
      `No se pudo consultar el estado de ${id}`
    );
  }

  // ---------------------------------------------------
  // 6. ELECCIÓN
  // ---------------------------------------------------

  setTimeout(() => {
    checkElectionAfterConnection(id);
  }, 300);

  return true;
}

// =====================================================
// COMPROBAR ELECCIÓN
// =====================================================

async function checkElectionAfterConnection() {
  const currentCoordinator = coordinatorId;

  if (!currentCoordinator) {
    await startElection();
    return;
  }

  if (currentCoordinator === NODE_ID) {
    return;
  }

  if (isHigher(NODE_ID, currentCoordinator)) {
    await startElection();
  }
}

// =====================================================
// ALGORITMO BULLY
// =====================================================

async function startElection() {
  if (electionInProgress) {
    return;
  }

  electionInProgress = true;

  electionNumber++;

  const currentElection = electionNumber;

  logEvent(
    `Elección ${currentElection} iniciada por ${NODE_ID}`
  );

  const higherPeers = Object.values(peers).filter(
    peer => isHigher(peer.id, NODE_ID)
  );

  // Nadie tiene mayor prioridad
  if (higherPeers.length === 0) {
    await becomeCoordinator();

    electionInProgress = false;
    return;
  }

  let higherAlive = false;

  for (const peer of higherPeers) {
    try {
      const response = await axios.post(
        `${peer.url}/election/elect`,
        {
          from: NODE_ID,
          election: currentElection
        },
        {
          timeout: 5000
        }
      );

      if (response.data && response.data.ok) {
        higherAlive = true;
      }
    } catch (error) {
      logEvent(
        `Nodo superior ${peer.id} no responde`
      );
    }
  }

  if (!higherAlive) {
    await becomeCoordinator();
  } else {
    logEvent(
      `Nodo ${NODE_ID} espera al nodo de mayor prioridad`
    );
  }

  electionInProgress = false;
}

// =====================================================
// CONVERTIRSE EN COORDINADOR
// =====================================================

async function becomeCoordinator() {
  coordinatorId = NODE_ID;

  for (const peer of Object.values(peers)) {
    peer.coordinator = false;
  }

  logEvent(
    `Nodo ${NODE_ID} gana la elección y es coordinador`
  );

  for (const peer of Object.values(peers)) {
    try {
      await axios.post(
        `${peer.url}/election/coordinator`,
        {
          id: NODE_ID,
          url: MY_URL
        },
        {
          timeout: 5000
        }
      );

      peer.coordinator = false;
    } catch (error) {
      logEvent(
        `No se pudo informar a ${peer.id} del nuevo coordinador`
      );
    }
  }
}

// =====================================================
// PING GET
// =====================================================

app.get("/election/ping", (req, res) => {
  const remoteId = req.headers["x-node-id"];
  const remoteUrl = req.headers["x-node-url"];

  if (
    remoteId &&
    remoteUrl &&
    remoteId !== NODE_ID
  ) {
    addPeer(
      remoteId,
      remoteUrl,
      remoteId === coordinatorId
    );
  }

  res.json({
    ok: true,
    id: NODE_ID,
    url: MY_URL,
    coordinator: coordinatorId,
    timestamp: Date.now()
  });
});

// =====================================================
// PING POST
// =====================================================

app.post("/election/ping", (req, res) => {
  const {
    id,
    url,
    coordinator
  } = req.body;

  if (
    id &&
    url &&
    id !== NODE_ID
  ) {
    addPeer(
      id,
      url,
      id === coordinator
    );
  }

  if (coordinator) {
    coordinatorId = coordinator;

    for (const peer of Object.values(peers)) {
      peer.coordinator = peer.id === coordinator;
    }
  }

  res.json({
    ok: true,
    id: NODE_ID,
    url: MY_URL,
    coordinator: coordinatorId
  });
});

// =====================================================
// REGISTRO BIDIRECCIONAL
// =====================================================

app.post(
  "/register-coordinator",
  async (req, res) => {
    const {
      id,
      url,
      coordinator
    } = req.body;

    if (!id || !url) {
      return res.status(400).json({
        ok: false,
        message: "Faltan id y url"
      });
    }

    if (id === NODE_ID) {
      return res.json({
        ok: true,
        message: "Es el mismo nodo"
      });
    }

    addPeer(
      id,
      url,
      id === coordinator
    );

    if (coordinator) {
      coordinatorId = coordinator;
    }

    logEvent(
      `Registro recibido desde ${id}: ${url}`
    );

    // Confirmar conexión al nodo remoto
    try {
      await axios.post(
        `${url}/election/ping`,
        {
          id: NODE_ID,
          url: MY_URL,
          coordinator: coordinatorId
        },
        {
          timeout: 5000
        }
      );

      logEvent(
        `Confirmación enviada a ${id}`
      );
    } catch (error) {
      logEvent(
        `No se pudo confirmar conexión con ${id}`
      );
    }

    // Comprobar elección
    setTimeout(() => {
      checkElectionAfterConnection();
    }, 500);

    res.json({
      ok: true,
      message: `Nodo ${id} registrado correctamente`,
      node: {
        id: NODE_ID,
        url: MY_URL
      },
      coordinator: coordinatorId
    });
  }
);

// =====================================================
// CONECTAR DESDE LA INTERFAZ
// =====================================================

app.post("/election/connect", async (req, res) => {
  try {
    const {
      id,
      url
    } = req.body;

    if (!id || !url) {
      return res.status(400).json({
        ok: false,
        message: "Debes ingresar el ID y la URL"
      });
    }

    await connectToPeer(id, url);

    res.json({
      ok: true,
      message: `Conectado correctamente con ${id}`,
      node: {
        id,
        url: normalizeUrl(url)
      },
      coordinator: coordinatorId
    });
  } catch (error) {
    console.error(error.message);

    res.status(400).json({
      ok: false,
      message: error.message
    });
  }
});

// Alias
app.post("/api/connect", async (req, res) => {
  try {
    const {
      id,
      url
    } = req.body;

    await connectToPeer(id, url);

    res.json({
      ok: true,
      message: `Conectado correctamente con ${id}`,
      coordinator: coordinatorId
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error.message
    });
  }
});

// =====================================================
// ESTADO
// =====================================================

app.get("/election/state", (req, res) => {
  res.json({
    ok: true,
    id: NODE_ID,
    url: MY_URL,
    coordinator: coordinatorId,
    election: electionNumber,
    peers: Object.values(peers)
  });
});

app.get("/election/status", (req, res) => {
  res.json({
    ok: true,
    node: NODE_ID,
    coordinator: coordinatorId,
    peers: Object.keys(peers),
    election: electionNumber
  });
});

// =====================================================
// RECIBIR ELECCIÓN
// =====================================================

app.post("/election/elect", async (req, res) => {
  const from = req.body.from;

  logEvent(
    `Solicitud de elección recibida desde ${from}`
  );

  res.json({
    ok: true,
    id: NODE_ID,
    coordinator: coordinatorId
  });

  if (
    from &&
    isHigher(NODE_ID, from)
  ) {
    setTimeout(() => {
      startElection();
    }, 100);
  }
});

// =====================================================
// RECIBIR COORDINADOR
// =====================================================

app.post(
  "/election/coordinator",
  (req, res) => {
    const {
      id,
      url
    } = req.body;

    if (id) {
      coordinatorId = id;

      if (
        url &&
        id !== NODE_ID
      ) {
        addPeer(
          id,
          url,
          true
        );
      }

      for (const peer of Object.values(peers)) {
        peer.coordinator = peer.id === id;
      }

      logEvent(
        `Nuevo coordinador recibido: ${id}`
      );
    }

    res.json({
      ok: true,
      coordinator: coordinatorId
    });
  }
);

// =====================================================
// ELECCIÓN MANUAL
// =====================================================

app.post(
  "/election/start",
  async (req, res) => {
    await startElection();

    res.json({
      ok: true,
      message: "Elección iniciada",
      coordinator: coordinatorId
    });
  }
);

// =====================================================
// SERVIDORES
// =====================================================

app.get("/servers", (req, res) => {
  res.json({
    ok: true,
    servers: Object.values(workers)
  });
});

// =====================================================
// WORKERS
// =====================================================

app.post("/register", (req, res) => {
  const {
    name,
    url
  } = req.body;

  if (!name || !url) {
    return res.status(400).json({
      ok: false,
      message: "name y url son obligatorios"
    });
  }

  workers[name] = {
    name,
    url: normalizeUrl(url),
    lastSeen: Date.now(),
    status: "ONLINE"
  };

  logEvent(
    `Worker registrado: ${name}`
  );

  res.json({
    ok: true,
    message: `Worker ${name} registrado`
  });
});

app.post(
  "/heartbeat/:name",
  (req, res) => {
    const name = req.params.name;

    if (workers[name]) {
      workers[name].lastSeen = Date.now();
      workers[name].status = "ONLINE";
    }

    res.json({
      ok: true
    });
  }
);

// =====================================================
// MENSAJES
// =====================================================

app.get("/messages", (req, res) => {
  res.json({
    ok: true,
    messages
  });
});

app.post(
  "/send-message/:name",
  async (req, res) => {
    const name = req.params.name;

    const worker = workers[name];

    if (!worker) {
      return res.status(404).json({
        ok: false,
        message: "Worker no encontrado"
      });
    }

    try {
      const response = await axios.post(
        `${worker.url}/send-message`,
        req.body,
        {
          timeout: 5000
        }
      );

      messages.push({
        from: NODE_ID,
        to: name,
        message: req.body,
        timestamp: Date.now()
      });

      res.json({
        ok: true,
        response: response.data
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: error.message
      });
    }
  }
);

// =====================================================
// MENSAJES ENTRE PEERS
// =====================================================

app.post(
  "/api/send-custom",
  async (req, res) => {
    const {
      id,
      message
    } = req.body;

    if (!id || !message) {
      return res.status(400).json({
        ok: false,
        message: "id y message son obligatorios"
      });
    }

    const peer = peers[id];

    if (!peer) {
      return res.status(404).json({
        ok: false,
        message: "Nodo no encontrado"
      });
    }

    try {
      await axios.post(
        `${peer.url}/api/receive-message`,
        {
          from: NODE_ID,
          message
        },
        {
          timeout: 5000
        }
      );

      messages.push({
        from: NODE_ID,
        to: id,
        message,
        timestamp: Date.now()
      });

      res.json({
        ok: true,
        message: "Mensaje enviado"
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: error.message
      });
    }
  }
);

app.post(
  "/api/receive-message",
  (req, res) => {
    const {
      from,
      message
    } = req.body;

    messages.push({
      from,
      to: NODE_ID,
      message,
      timestamp: Date.now()
    });

    logEvent(
      `Mensaje recibido desde ${from}`
    );

    res.json({
      ok: true
    });
  }
);

// =====================================================
// ELIMINAR WORKER
// =====================================================

app.post(
  "/kill-server/:name",
  (req, res) => {
    const name = req.params.name;

    if (!workers[name]) {
      return res.status(404).json({
        ok: false,
        message: "Worker no encontrado"
      });
    }

    delete workers[name];

    logEvent(
      `Worker eliminado: ${name}`
    );

    res.json({
      ok: true
    });
  }
);

// =====================================================
// ELIMINAR PEER
// =====================================================

app.post(
  "/api/disconnect/:id",
  (req, res) => {
    const id = req.params.id;

    if (!peers[id]) {
      return res.status(404).json({
        ok: false,
        message: "Nodo no encontrado"
      });
    }

    removePeer(id);

    res.json({
      ok: true,
      message: `Nodo ${id} desconectado`
    });
  }
);

// =====================================================
// HEALTH
// =====================================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    node: NODE_ID,
    url: MY_URL,
    coordinator: coordinatorId,
    uptime: process.uptime()
  });
});

// =====================================================
// KILL
// =====================================================

app.post("/kill", (req, res) => {
  res.json({
    ok: true,
    message: `Nodo ${NODE_ID} apagándose`
  });

  setTimeout(() => {
    process.exit(0);
  }, 300);
});

// =====================================================
// API OVERVIEW
// =====================================================

app.get("/api/overview", (req, res) => {
  res.json({
    nodeId: NODE_ID,
    url: MY_URL,
    coordinator: coordinatorId,

    role:
      coordinatorId === NODE_ID
        ? "COORDINADOR"
        : "NODO",

    election: electionNumber,

    peers: Object.values(peers).map(peer => ({
      id: peer.id,
      url: peer.url,
      coordinator:
        peer.id === coordinatorId,
      lastSeen: peer.lastSeen,
      status:
        Date.now() - peer.lastSeen < 10000
          ? "ONLINE"
          : "OFFLINE"
    })),

    workers: Object.values(workers),

    messages: messages.length,

    events: events.slice(0, 50)
  });
});

app.get("/api/messages", (req, res) => {
  res.json({
    messages
  });
});

app.get("/api/stats", (req, res) => {
  res.json({
    node: NODE_ID,
    coordinator: coordinatorId,
    peers: Object.keys(peers).length,
    workers: Object.keys(workers).length,
    messages: messages.length,
    events: events.length,
    election: electionNumber
  });
});

// =====================================================
// HEARTBEAT DE PEERS
// =====================================================

setInterval(async () => {
  for (const id of Object.keys(peers)) {
    const peer = peers[id];

    try {
      const response = await axios.get(
        `${peer.url}/election/ping`,
        {
          timeout: 4000,
          headers: {
            "X-Node-ID": NODE_ID,
            "X-Node-URL": MY_URL
          }
        }
      );

      peer.lastSeen = Date.now();

      if (
        response.data &&
        response.data.coordinator
      ) {
        coordinatorId =
          response.data.coordinator;
      }

      peer.coordinator =
        peer.id === coordinatorId;

    } catch (error) {
      const elapsed =
        Date.now() - peer.lastSeen;

      if (elapsed > 10000) {
        const wasCoordinator =
          coordinatorId === id;

        logEvent(
          `Nodo ${id} desconectado`
        );

        delete peers[id];

        if (wasCoordinator) {
          logEvent(
            `El coordinador ${id} dejó de responder`
          );

          coordinatorId = null;

          setTimeout(() => {
            startElection();
          }, 500);
        }
      }
    }
  }
}, 3000);

// =====================================================
// LIMPIAR WORKERS
// =====================================================

setInterval(() => {
  const now = Date.now();

  for (const name of Object.keys(workers)) {
    if (
      now - workers[name].lastSeen >
      15000
    ) {
      workers[name].status = "OFFLINE";
    }
  }
}, 5000);

// =====================================================
// INTERFAZ WEB COMPLETA
// =====================================================

const dashboardHTML = `
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>Sistema Distribuido</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: #f4f6f8;
  color: #202124;
}

header {
  background: #111827;
  color: white;
  padding: 22px;
}

header h1 {
  margin: 0 0 6px;
}

header p {
  margin: 0;
  color: #cbd5e1;
}

.container {
  max-width: 1200px;
  margin: auto;
  padding: 25px;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fit, minmax(280px, 1fr));
  gap: 18px;
}

.card {
  background: white;
  border-radius: 12px;
  padding: 20px;
  box-shadow:
    0 3px 12px rgba(0,0,0,.08);
}

.card h2 {
  margin-top: 0;
  font-size: 19px;
}

.info {
  margin: 8px 0;
}

.label {
  font-weight: bold;
}

input {
  width: 100%;
  padding: 11px;
  margin: 7px 0 12px;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  font-size: 14px;
}

button {
  border: 0;
  border-radius: 7px;
  padding: 10px 15px;
  cursor: pointer;
  background: #2563eb;
  color: white;
  margin-right: 5px;
  margin-bottom: 5px;
}

button:hover {
  opacity: .9;
}

button.secondary {
  background: #475569;
}

button.danger {
  background: #dc2626;
}

.node {
  border: 1px solid #e2e8f0;
  border-radius: 9px;
  padding: 13px;
  margin: 10px 0;
}

.online {
  color: #15803d;
  font-weight: bold;
}

.offline {
  color: #dc2626;
  font-weight: bold;
}

.coordinator {
  color: #7c3aed;
  font-weight: bold;
}

#message {
  padding: 12px;
  border-radius: 7px;
  margin-bottom: 15px;
  display: none;
}

.success {
  background: #dcfce7;
  color: #166534;
}

.error {
  background: #fee2e2;
  color: #991b1b;
}

pre {
  white-space: pre-wrap;
  word-break: break-word;
  background: #111827;
  color: #e5e7eb;
  padding: 15px;
  border-radius: 8px;
  max-height: 350px;
  overflow: auto;
}

.stat {
  font-size: 30px;
  font-weight: bold;
}

</style>
</head>

<body>

<header>

<h1>Sistema Distribuido</h1>

<p>
Coordinadores dinámicos — Algoritmo Bully
</p>

</header>

<div class="container">

<div id="message"></div>

<div class="grid">

<div class="card">

<h2>Mi nodo</h2>

<div class="info">
<span class="label">ID:</span>
<span id="nodeId">-</span>
</div>

<div class="info">
<span class="label">URL:</span>
<span id="nodeUrl">-</span>
</div>

<div class="info">
<span class="label">Rol:</span>
<span id="role">-</span>
</div>

<div class="info">
<span class="label">Coordinador:</span>
<span id="coordinator">-</span>
</div>

<div class="info">
<span class="label">Elección:</span>
<span id="election">-</span>
</div>

</div>

<div class="card">

<h2>Conectar servidor</h2>

<label>ID del servidor</label>

<input
  id="connectId"
  placeholder="Ejemplo: B"
>

<label>URL del servidor</label>

<input
  id="connectUrl"
  placeholder="http://localhost:3001 o https://xxxx.ngrok-free.dev"
>

<button onclick="connectServer()">
Conectar
</button>

<p>
Puedes usar localhost para pruebas en el mismo PC
o una URL de ngrok para otro computador.
</p>

</div>

</div>

<br>

<div class="grid">

<div class="card">

<h2>Estadísticas</h2>

<div class="info">
Peers conectados:
<div class="stat" id="peerCount">0</div>
</div>

<div class="info">
Workers:
<div class="stat" id="workerCount">0</div>
</div>

<div class="info">
Mensajes:
<div class="stat" id="messageCount">0</div>
</div>

</div>

<div class="card">

<h2>Acciones</h2>

<button onclick="startElection()">
Iniciar elección
</button>

<button
  class="secondary"
  onclick="loadData()"
>
Actualizar
</button>

</div>

</div>

<br>

<div class="card">

<h2>Nodos conectados</h2>

<div id="peers">
No hay otros nodos conectados.
</div>

</div>

<br>

<div class="card">

<h2>Workers</h2>

<div id="workers">
No hay servidores de trabajo.
</div>

</div>

<br>

<div class="card">

<h2>Eventos</h2>

<pre id="events">
Sin eventos.
</pre>

</div>

</div>

<script>

function showMessage(text, type) {

  const box =
    document.getElementById("message");

  box.innerText = text;

  box.className = type;

  box.style.display = "block";

  setTimeout(() => {
    box.style.display = "none";
  }, 5000);
}

async function connectServer() {

  const id =
    document
      .getElementById("connectId")
      .value
      .trim();

  const url =
    document
      .getElementById("connectUrl")
      .value
      .trim();

  if (!id || !url) {

    showMessage(
      "Debes ingresar ID y URL.",
      "error"
    );

    return;
  }

  try {

    const response =
      await fetch(
        "/election/connect",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            id,
            url
          })
        }
      );

    const data =
      await response.json();

    if (!response.ok || !data.ok) {

      throw new Error(
        data.message ||
        "No se pudo conectar"
      );
    }

    showMessage(
      data.message,
      "success"
    );

    document
      .getElementById("connectId")
      .value = "";

    document
      .getElementById("connectUrl")
      .value = "";

    await loadData();

  } catch (error) {

    showMessage(
      error.message,
      "error"
    );
  }
}

async function startElection() {

  try {

    const response =
      await fetch(
        "/election/start",
        {
          method: "POST"
        }
      );

    const data =
      await response.json();

    showMessage(
      data.message ||
      "Elección iniciada",
      "success"
    );

    setTimeout(loadData, 500);

  } catch (error) {

    showMessage(
      error.message,
      "error"
    );
  }
}

async function disconnectPeer(id) {

  if (
    !confirm(
      "¿Desconectar el nodo " +
      id +
      "?"
    )
  ) {
    return;
  }

  try {

    const response =
      await fetch(
        "/api/disconnect/" +
        encodeURIComponent(id),
        {
          method: "POST"
        }
      );

    const data =
      await response.json();

    if (!data.ok) {
      throw new Error(data.message);
    }

    showMessage(
      data.message,
      "success"
    );

    await loadData();

  } catch (error) {

    showMessage(
      error.message,
      "error"
    );
  }
}

async function loadData() {

  try {

    const response =
      await fetch(
        "/api/overview"
      );

    const data =
      await response.json();

    document
      .getElementById("nodeId")
      .innerText =
      data.nodeId;

    document
      .getElementById("nodeUrl")
      .innerText =
      data.url;

    document
      .getElementById("role")
      .innerText =
      data.role;

    document
      .getElementById("coordinator")
      .innerText =
      data.coordinator || "-";

    document
      .getElementById("election")
      .innerText =
      data.election;

    document
      .getElementById("peerCount")
      .innerText =
      data.peers.length;

    document
      .getElementById("workerCount")
      .innerText =
      data.workers.length;

    document
      .getElementById("messageCount")
      .innerText =
      data.messages;

    renderPeers(data.peers);

    renderWorkers(data.workers);

    document
      .getElementById("events")
      .innerText =
      data.events.length
        ? data.events.join("\\n")
        : "Sin eventos.";

  } catch (error) {

    console.error(error);
  }
}

function renderPeers(peers) {

  const container =
    document.getElementById("peers");

  if (!peers.length) {

    container.innerHTML =
      "No hay otros nodos conectados.";

    return;
  }

  container.innerHTML =
    peers.map(peer => {

      const statusClass =
        peer.status === "ONLINE"
          ? "online"
          : "offline";

      return \`
        <div class="node">

          <strong>
            Nodo \${peer.id}
          </strong>

          <br>

          URL:
          \${peer.url}

          <br>

          Estado:
          <span class="\${statusClass}">
            \${peer.status}
          </span>

          <br>

          Rol:
          <span class="\${peer.coordinator ? "coordinator" : ""}">
            \${peer.coordinator
              ? "COORDINADOR"
              : "NODO"}
          </span>

          <br><br>

          <button
            class="danger"
            onclick="disconnectPeer('\${peer.id}')"
          >
            Desconectar
          </button>

        </div>
      \`;

    }).join("");
}

function renderWorkers(workers) {

  const container =
    document.getElementById("workers");

  if (!workers.length) {

    container.innerHTML =
      "No hay servidores de trabajo.";

    return;
  }

  container.innerHTML =
    workers.map(worker => \`

      <div class="node">

        <strong>
          \${worker.name}
        </strong>

        <br>

        URL:
        \${worker.url}

        <br>

        Estado:
        \${worker.status}

      </div>

    \`).join("");
}

loadData();

setInterval(
  loadData,
  3000
);

</script>

</body>
</html>
`;

// =====================================================
// DASHBOARD
// =====================================================

app.get("/", (req, res) => {
  res.send(dashboardHTML);
});

// =====================================================
// INICIAR
// =====================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");

    console.log(
      "======================================"
    );

    console.log(
      " SISTEMA DISTRIBUIDO"
    );

    console.log(
      "======================================"
    );

    console.log(
      `Nodo:        ${NODE_ID}`
    );

    console.log(
      `Puerto:      ${PORT}`
    );

    console.log(
      `URL pública: ${MY_URL}`
    );

    console.log(
      `Coordinador: ${coordinatorId}`
    );

    console.log(
      "======================================"
    );

    console.log("");

    logEvent(
      `Nodo ${NODE_ID} iniciado en ${MY_URL}`
    );

    logEvent(
      `Soy el coordinador inicial: ${NODE_ID}`
    );
  }
);