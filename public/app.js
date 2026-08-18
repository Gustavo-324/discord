let token = localStorage.getItem("valtrix_token");
let me = null;
let socket = null;
let current = null;
let groups = [];
let registering = false;

const $ = id => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

async function api(url, opts = {}) {
  const headers = {
    ...(opts.headers || {}),
    "Content-Type": "application/json"
  };

  if (token) headers.Authorization = "Bearer " + token;

  const res = await fetch(url, { ...opts, headers });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || "Erro no servidor.");
  }

  return data;
}

function showError(message) {
  $("err").textContent = message;
}

$("loginTab").onclick = () => {
  registering = false;
  $("name").hidden = true;
  $("authBtn").textContent = "Entrar";
  showError("");
};

$("regTab").onclick = () => {
  registering = true;
  $("name").hidden = false;
  $("authBtn").textContent = "Criar conta";
  showError("");
};

$("authBtn").onclick = loginOrRegister;

$("pass").addEventListener("keydown", e => {
  if (e.key === "Enter") loginOrRegister();
});

$("user").addEventListener("keydown", e => {
  if (e.key === "Enter") loginOrRegister();
});

async function loginOrRegister() {
  showError("");

  const username = $("user").value.trim();
  const password = $("pass").value;

  if (!username || !password) {
    return showError("Preencha usuário e senha.");
  }

  if (registering && !$("name").value.trim()) {
    return showError("Digite seu nome.");
  }

  $("authBtn").disabled = true;
  $("authBtn").textContent = registering
    ? "Criando..."
    : "Entrando...";

  try {
    const data = await api(
      registering ? "/api/register" : "/api/login",
      {
        method: "POST",
        body: JSON.stringify({
          username,
          password,
          displayName: $("name").value.trim()
        })
      }
    );

    token = data.token;
    localStorage.setItem("valtrix_token", token);

    await start();
  } catch (err) {
    showError(err.message);
  } finally {
    $("authBtn").disabled = false;
    $("authBtn").textContent = registering
      ? "Criar conta"
      : "Entrar";
  }
}

async function start() {
  try {
    const data = await api("/api/me");
    me = data.user;

    $("auth").hidden = true;
    $("app").hidden = false;
    $("me").textContent =
      `${me.display_name} @${me.username}`;

    connectSocket();
    await loadGroups();
  } catch (err) {
    localStorage.removeItem("valtrix_token");
    token = null;
    $("auth").hidden = false;
    $("app").hidden = true;
    showError(err.message);
  }
}

function connectSocket() {
  socket = io({
    auth: { token }
  });

  socket.on("connect", () => {
    $("status").textContent = "online";

    if (current) {
      socket.emit("join-group", {
        groupId: current.id
      });
    }
  });

  socket.on("disconnect", () => {
    $("status").textContent = "offline";
  });

  socket.on("connect_error", err => {
    console.error("Socket:", err.message);
  });

  socket.on("presence", users => {
    $("people").innerHTML = users.map(u => `
      <div class="item">
        ${esc(u.display_name)}
        <span class="${u.online ? "online" : "offline"}">
          ${u.online ? "● online" : "● offline"}
        </span>
      </div>
    `).join("");
  });

  socket.on("message", msg => {
    if (current && Number(msg.groupId) === Number(current.id)) {
      addMessage(msg);
    }
  });
}

async function loadGroups() {
  const data = await api("/api/groups");
  groups = data.groups;

  $("groups").innerHTML = groups.map(g => `
    <div class="item" onclick="openGroup(${g.id})">
      ${esc(g.name)}
    </div>
  `).join("");
}

window.openGroup = async function(id) {
  current = groups.find(g => Number(g.id) === Number(id));

  if (!current) return;

  $("title").textContent = current.name;
  $("text").disabled = false;
  $("messages").innerHTML = "";

  socket.emit("join-group", {
    groupId: current.id
  });

  try {
    const [messages, members] = await Promise.all([
      api(`/api/groups/${current.id}/messages`),
      api(`/api/groups/${current.id}/members`)
    ]);

    messages.messages.forEach(addMessage);

    $("people").innerHTML = members.members.map(u => `
      <div class="item">
        ${esc(u.display_name)}
      </div>
    `).join("");
  } catch (err) {
    alert(err.message);
  }
};

function addMessage(m) {
  const uid = m.user_id ?? m.userId;
  const name = m.display_name ?? m.displayName ?? m.username;

  $("messages").insertAdjacentHTML("beforeend", `
    <div class="msg ${Number(uid) === Number(me.id) ? "mine" : ""}">
      <div class="meta">${esc(name)}</div>
      <span class="bubble">${esc(m.text)}</span>
    </div>
  `);

  $("messages").scrollTop = $("messages").scrollHeight;
}

$("form").onsubmit = e => {
  e.preventDefault();

  const text = $("text").value.trim();

  if (!text || !current) return;

  socket.emit("message", {
    groupId: current.id,
    text
  });

  $("text").value = "";
};

$("newGroup").onclick = async () => {
  const name = prompt("Nome do grupo:");

  if (!name) return;

  try {
    await api("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name })
    });

    await loadGroups();
  } catch (err) {
    alert(err.message);
  }
};

if (token) {
  start();
}