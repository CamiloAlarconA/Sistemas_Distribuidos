const fs = require("fs");
const express = require("express");

const app = express();
app.use(express.json());

const PORT =  3000;

//ALMACENAMIENTO EN MEMORIA
let servers = {};
let messages = {};

//SERVERS
let serverProcess = {};
let nextPort = 4000;

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
app.post("/pulse/:name", (req, res) => {
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

//GET ROOT - INTERFAZ
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Middleware - Monitor</title>
<style>
  body { font-family: Arial, sans-serif; background: #1e1e1e; color: #eee; padding: 20px; }
  h1, h2 { color: #4fc3f7; }
  .panel { background: #2a2a2a; border-radius: 8px; padding: 15px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid #444; }
  .msg { border-left: 3px solid #4fc3f7; padding: 6px 10px; margin-bottom: 6px; background: #333; border-radius: 4px; }
  .msg small { color: #999; display: block; }
  .empty { color: #888; font-style: italic; }
</style>
</head>
<body>

<h1>Monitor del Middleware</h1>

<div class="panel">
  <h2>Servidores conectados</h2>
  <table>
    <thead>
      <tr><th>Nombre</th><th>URL</th><th>Último heartbeat</th></tr>
    </thead>
    <tbody id="servers-body"></tbody>
  </table>
</div>

<div class="panel">
  <h2>Mensajes recibidos</h2>
  <div id="messages-container"></div>
</div>

<script>
  const REFRESH_MS = 3000;

  async function fetchServers() {
    const res = await fetch("/servers");
    return res.json();
  }

  async function fetchMessages(name) {
    const res = await fetch(\`/send-message/\${name}\`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.messages || []).map(m => ({ ...m, server: name }));
  }

  async function refresh() {
    const servers = await fetchServers();

    const tbody = document.getElementById("servers-body");
    tbody.innerHTML = servers.length
      ? servers.map(s => \`
          <tr>
            <td>\${s.name}</td>
            <td>\${s.url}</td>
            <td>\${new Date(s.lastHeartbeat).toLocaleTimeString()}</td>
          </tr>
        \`).join("")
      : \`<tr><td colspan="3" class="empty">No hay servidores conectados</td></tr>\`;

    const allMessages = (await Promise.all(servers.map(s => fetchMessages(s.name)))).flat();
    allMessages.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));

    const container = document.getElementById("messages-container");
    container.innerHTML = allMessages.length
      ? allMessages.map(m => \`
          <div class="msg">
            <strong>\${m.server}</strong>: \${m.message}
            <small>\${new Date(m.receivedAt).toLocaleString()}</small>
          </div>
        \`).join("")
      : \`<p class="empty">No hay mensajes</p>\`;
  }

  refresh();
  setInterval(refresh, REFRESH_MS);
</script>

</body>
</html>
  `);
});
