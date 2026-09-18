async function getJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    throw new Error(
      `El servidor respondió algo que no es JSON (HTTP ${response.status}).`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("El servidor devolvió JSON inválido.");
  }

  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  return data;
}

async function loadOverview() {
  try {
    const data = await getJson("/api/overview");
    render(data);
  } catch (error) {
    console.error(error);
  }
}

function render(data) {
  const node = data.node || {};
  const peers = data.peers || [];
  const workers = data.workers || [];
  const messages = data.messages || [];

  setText("nodeId", node.id);
  setText("nodeUrl", node.url);
  setText("nodeRole", node.role);
  setText("coordinator", node.coordinator);
  setText("term", node.term);
  setText("electionState", node.electionState);

  setText("coordinatorCount", peers.length + 1);
  setText("connectedCount", peers.filter(p => p.online).length);
  setText("workerCount", workers.filter(w => w.online).length);
  setText("messageCount", messages.length);

  renderPeers(peers);
  renderWorkers(workers);
  renderMessages(messages);
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value ?? "-";
}

function renderPeers(peers) {
  const container = document.getElementById("peers");

  if (!peers.length) {
    container.innerHTML = `<div class="empty">No hay otros coordinadores conectados.</div>`;
    return;
  }

  container.innerHTML = peers.map(peer => `
    <article class="card">
      <h3>${escapeHtml(peer.id)}</h3>
      <p><b>URL:</b> ${escapeHtml(peer.url)}</p>
      <p><b>Rol:</b> ${escapeHtml(peer.role)}</p>
      <p>
        <b>Estado:</b>
        <span class="${peer.online ? "online" : "offline"}">
          ${peer.online ? "ONLINE" : "OFFLINE"}
        </span>
      </p>
    </article>
  `).join("");
}

function renderWorkers(workers) {
  const container = document.getElementById("workers");

  if (!workers.length) {
    container.innerHTML = `<div class="empty">No hay servidores de trabajo.</div>`;
    return;
  }

  container.innerHTML = workers.map(worker => `
    <article class="card">
      <h3>${escapeHtml(worker.name)}</h3>
      <p>${escapeHtml(worker.url)}</p>
      <p>
        <b>Estado:</b>
        <span class="${worker.online ? "online" : "offline"}">
          ${worker.online ? "ONLINE" : "OFFLINE"}
        </span>
      </p>
    </article>
  `).join("");
}

function renderMessages(messages) {
  const container = document.getElementById("messages");

  if (!messages.length) {
    container.innerHTML = `<div class="empty">No hay eventos.</div>`;
    return;
  }

  container.innerHTML = messages
    .slice()
    .reverse()
    .map(message => `
      <article class="message">
        <div>${escapeHtml(message.text || "")}</div>
        <small>${message.timestamp
          ? new Date(message.timestamp).toLocaleString()
          : ""}</small>
      </article>
    `)
    .join("");
}

async function connectPeer() {
  const id = document.getElementById("peerId").value.trim();
  const url = document.getElementById("peerUrl").value.trim();
  const button = document.getElementById("connectButton");

  if (!id || !url) {
    alert("Ingrese el ID y la URL ngrok.");
    return;
  }

  button.disabled = true;
  button.textContent = "Comprobando...";

  try {
    const data = await getJson("/election/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ id, url })
    });

    alert(data.message);

    document.getElementById("peerId").value = "";
    document.getElementById("peerUrl").value = "";

    await loadOverview();
  } catch (error) {
    alert("Error: " + error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Conectar";
  }
}

async function startElection() {
  try {
    const data = await getJson("/election/start", {
      method: "POST"
    });

    alert(data.message);
    await loadOverview();
  } catch (error) {
    alert("Error: " + error.message);
  }
}

async function clearMessages() {
  try {
    await getJson("/api/messages", {
      method: "DELETE"
    });

    await loadOverview();
  } catch (error) {
    alert("Error: " + error.message);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("connectButton")
    ?.addEventListener("click", connectPeer);

  document.getElementById("electionButton")
    ?.addEventListener("click", startElection);

  document.getElementById("clearButton")
    ?.addEventListener("click", clearMessages);

  document.getElementById("refreshButton")
    ?.addEventListener("click", loadOverview);

  loadOverview();
  setInterval(loadOverview, 2000);
});
