const fs = require("fs");
const express = require("express");

const app = express();
app.use(express.json());

const PORT = 3000;

//ALMACENAMIENTO EN MEMORIA
let servers = {};
let messages = {};

//SERVERS
let serverProcess = {};
let nextPort = 4000;

//GET ROOT
app.get("/", (req, res) => {
  res.send("Bienvenido al middleware de Camilo A");
});

//REGISTER SERVER
app.post("/register", (req, res) => {
  const { name, url } = req.body;

  if (!name || !url) {
    return res.status(400).json({ error: "Name and URL required" });
  }

  servers[name] = {
    name,
    url,
    lastHeartbeat: Date.now(),
  };

  console.log(`Server registered successfully: ${name}`);
  res.json({ message: "Server registered successfully" });
});

//HEARTBEAT
app.post("/heartbeat/:name", (req, res) => {
  const { name } = req.params;

  if (servers[name]) {
    servers[name].lastHeartbeat = Date.now();

    return res.json({ message: "Heartbeat received" });
  }

  res.status(400).json({ error: "Server not found" });
});

//Kill the server process
app.post("/kill-server/:name", (req, res) => {
  const { name } = req.params;

  if (!servers[name]) {
    return res.status(400).json({ error: "Server not found" });
  }

  serverProcess[name].process.kill();
  delete serverProcess[name];
  delete servers[name];

  console.log(`Server ${name} is killed`);
  res.json({ message: `${name} killed` });
});

//OBTENER SERVIDORES ACTIVOS
app.get("/servers", (req, res) => {
  res.json(Object.values(servers));
});

//TIMEOUT
setInterval(() => {
  const now = Date.now();
  const timeout = 15000;

  Object.keys(servers).forEach((name) => {
    if (now - servers[name].lastHeartbeat > timeout) {
      console.log(`Server ${name} timed out. Killing...`);

      if (serverProcess[name]) {
        serverProcess[name].process.kill();
        delete serverProcess[name];
      }
      delete servers[name];
    }
  });
}, 10000);

app.listen(PORT, () => {
  console.log(`Middleware corriendo en http://localhost:${PORT}`);
});

// RECIBIR MENSAJES
app.post("/send-message/:name", (req, res) => {
  const { name } = req.params;
  const { message } = req.body;

  // Verificar que el servidor exista
  if (!servers[name]) {
    return res.status(404).json({
      success: false,
      error: "Server not found",
    });
  }

  // Verificar mensaje
  if (!message) {
    return res.status(400).json({
      success: false,
      error: "Message required",
    });
  }

  // Crear almacenamiento
  if (!messages[name]) {
    messages[name] = [];
  }

  // Crear mensaje
  const newMessage = {
    message: message,
    receivedAt: new Date().toISOString(),
  };

  // Guardar mensaje
  messages[name].push(newMessage);

  // Mostrar en consola
  console.log("--------------------------------");
  console.log("MENSAJE RECIBIDO");
  console.log(`Server: ${name}`);
  console.log(`Mensaje: ${message}`);
  console.log(`Fecha: ${newMessage.receivedAt}`);
  console.log("--------------------------------");

  res.status(200).json({
    success: true,

    message: "Mensaje recibido correctamente",

    data: newMessage,
  });
});

//VER MENSAJES
app.get("/send-message/:name", (req, res) => {
  const { name } = req.params;

  // Verificar servidor
  if (!servers[name]) {
    return res.status(404).json({
      success: false,

      error: "Server not found",
    });
  }

  res.json({
    success: true,

    server: name,

    total: messages[name]?.length || 0,

    messages: messages[name] || [],
  });
});