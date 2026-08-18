require("dotenv").config();

const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "valtrix-dev-secret-change-me";

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "valtrix.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

function publicUser(id) {
  return db.prepare(
    "SELECT id, username, display_name FROM users WHERE id = ?"
  ).get(id);
}

function signUser(user) {
  return jwt.sign({
    id: user.id,
    username: user.username,
    displayName: user.display_name
  }, JWT_SECRET, { expiresIn: "30d" });
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Faça login primeiro." });
  }

  try {
    req.user = jwt.verify(header.substring(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Sessão expirada. Entre novamente." });
  }
}

function member(groupId, userId) {
  return !!db.prepare(
    "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?"
  ).get(groupId, userId);
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    version: "4.1",
    database: true
  });
});

app.post("/api/register", (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const displayName = String(
      req.body.displayName || username
    ).trim().slice(0, 40);

    const password = String(req.body.password || "");

    if (!username || username.length < 3) {
      return res.status(400).json({
        error: "O usuário precisa ter pelo menos 3 caracteres."
      });
    }

    if (!/^[a-z0-9_.-]+$/.test(username)) {
      return res.status(400).json({
        error: "Use somente letras, números, ponto, _ ou - no usuário."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "A senha precisa ter pelo menos 6 caracteres."
      });
    }

    const existing = db.prepare(
      "SELECT id FROM users WHERE username = ?"
    ).get(username);

    if (existing) {
      return res.status(409).json({
        error: "Esse usuário já existe."
      });
    }

    const hash = bcrypt.hashSync(password, 12);

    const result = db.prepare(`
      INSERT INTO users
        (username, password_hash, display_name, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      username,
      hash,
      displayName || username,
      Date.now()
    );

    const user = publicUser(result.lastInsertRowid);

    return res.status(201).json({
      ok: true,
      token: signUser(user),
      user
    });
  } catch (err) {
    console.error("REGISTER ERROR:", err);

    return res.status(500).json({
      error: "Erro interno ao criar a conta.",
      detail: process.env.NODE_ENV === "development"
        ? err.message
        : undefined
    });
  }
});

app.post("/api/login", (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({
        error: "Digite usuário e senha."
      });
    }

    const user = db.prepare(
      "SELECT * FROM users WHERE username = ?"
    ).get(username);

    if (!user) {
      return res.status(401).json({
        error: "Usuário ou senha incorretos."
      });
    }

    const valid = bcrypt.compareSync(
      password,
      user.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        error: "Usuário ou senha incorretos."
      });
    }

    const safeUser = publicUser(user.id);

    return res.json({
      ok: true,
      token: signUser(user),
      user: safeUser
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);

    return res.status(500).json({
      error: "Erro interno ao fazer login."
    });
  }
});

app.get("/api/me", auth, (req, res) => {
  const user = publicUser(req.user.id);

  if (!user) {
    return res.status(401).json({
      error: "Usuário não encontrado."
    });
  }

  res.json({ ok: true, user });
});

app.get("/api/config", auth, (req, res) => {
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" }
  ];

  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME || "",
      credential: process.env.TURN_CREDENTIAL || ""
    });
  }

  res.json({ iceServers });
});

app.get("/api/groups", auth, (req, res) => {
  const groups = db.prepare(`
    SELECT g.id, g.name, g.owner_id, g.created_at
    FROM groups g
    INNER JOIN group_members gm
      ON gm.group_id = g.id
    WHERE gm.user_id = ?
    ORDER BY g.id DESC
  `).all(req.user.id);

  res.json({ groups });
});

app.post("/api/groups", auth, (req, res) => {
  const name = String(req.body.name || "").trim();

  if (!name) {
    return res.status(400).json({
      error: "Digite um nome para o grupo."
    });
  }

  const result = db.prepare(`
    INSERT INTO groups(name, owner_id, created_at)
    VALUES (?, ?, ?)
  `).run(name.slice(0, 60), req.user.id, Date.now());

  db.prepare(`
    INSERT INTO group_members(group_id, user_id)
    VALUES (?, ?)
  `).run(result.lastInsertRowid, req.user.id);

  res.json({
    group: db.prepare(
      "SELECT id, name, owner_id, created_at FROM groups WHERE id = ?"
    ).get(result.lastInsertRowid)
  });
});

app.get("/api/groups/:id/messages", auth, (req, res) => {
  const id = Number(req.params.id);

  if (!member(id, req.user.id)) {
    return res.status(403).json({
      error: "Você não pertence a este grupo."
    });
  }

  const messages = db.prepare(`
    SELECT
      m.id,
      m.group_id,
      m.user_id,
      m.text,
      m.created_at,
      u.username,
      u.display_name
    FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ?
    ORDER BY m.id ASC
    LIMIT 100
  `).all(id);

  res.json({ messages });
});

app.get("/api/groups/:id/members", auth, (req, res) => {
  const id = Number(req.params.id);

  if (!member(id, req.user.id)) {
    return res.status(403).json({
      error: "Você não pertence a este grupo."
    });
  }

  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name
    FROM users u
    JOIN group_members gm ON gm.user_id = u.id
    WHERE gm.group_id = ?
    ORDER BY u.display_name
  `).all(id);

  res.json({ members });
});

const online = new Map();

function broadcastPresence(groupId) {
  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name
    FROM users u
    JOIN group_members gm ON gm.user_id = u.id
    WHERE gm.group_id = ?
  `).all(groupId);

  io.to("group:" + groupId).emit(
    "presence",
    members.map(u => ({
      ...u,
      online: (online.get(u.id)?.size || 0) > 0
    }))
  );
}

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    if (!token) return next(new Error("AUTH_REQUIRED"));

    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error("AUTH_INVALID"));
  }
});

io.on("connection", socket => {
  const uid = socket.user.id;

  if (!online.has(uid)) online.set(uid, new Set());
  online.get(uid).add(socket.id);

  socket.data.groups = new Set();

  socket.on("join-group", ({ groupId }) => {
    groupId = Number(groupId);

    if (!member(groupId, uid)) return;

    socket.join("group:" + groupId);
    socket.data.groups.add(groupId);
    broadcastPresence(groupId);
  });

  socket.on("message", ({ groupId, text }) => {
    groupId = Number(groupId);
    text = String(text || "").trim().slice(0, 4000);

    if (!text || !member(groupId, uid)) return;

    const result = db.prepare(`
      INSERT INTO messages
        (group_id, user_id, text, created_at)
      VALUES (?, ?, ?, ?)
    `).run(groupId, uid, text, Date.now());

    const user = publicUser(uid);

    io.to("group:" + groupId).emit("message", {
      id: result.lastInsertRowid,
      groupId,
      userId: uid,
      username: user.username,
      displayName: user.display_name,
      text,
      time: Date.now()
    });
  });

  // WebRTC signaling
  socket.on("rtc:offer", data => {
    if (data?.to && data.offer) {
      io.to(data.to).emit("rtc:offer", {
        from: socket.id,
        offer: data.offer,
        callId: data.callId
      });
    }
  });

  socket.on("rtc:answer", data => {
    if (data?.to && data.answer) {
      io.to(data.to).emit("rtc:answer", {
        from: socket.id,
        answer: data.answer,
        callId: data.callId
      });
    }
  });

  socket.on("rtc:ice", data => {
    if (data?.to && data.candidate) {
      io.to(data.to).emit("rtc:ice", {
        from: socket.id,
        candidate: data.candidate,
        callId: data.callId
      });
    }
  });

  socket.on("rtc:hangup", data => {
    if (data?.to) {
      io.to(data.to).emit("rtc:hangup", {
        from: socket.id,
        callId: data.callId
      });
    }
  });

  socket.on("call:join", data => {
    const groupId = Number(data?.groupId);

    if (!member(groupId, uid)) return;

    socket.to("group:" + groupId).emit("call:join", {
      peerId: socket.id,
      kind: data.kind,
      user: socket.user
    });
  });

  socket.on("call:leave", data => {
    const groupId = Number(data?.groupId);

    if (!member(groupId, uid)) return;

    socket.to("group:" + groupId).emit("call:leave", {
      peerId: socket.id
    });
  });

  socket.on("disconnect", () => {
    const set = online.get(uid);

    if (set) {
      set.delete(socket.id);
      if (!set.size) online.delete(uid);
    }

    for (const groupId of socket.data.groups) {
      broadcastPresence(groupId);
    }
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  if (req.path.startsWith("/api/") ||
      req.path.startsWith("/socket.io/")) {
    return next();
  }

  if (req.method === "GET") {
    return res.sendFile(
      path.join(__dirname, "public", "index.html")
    );
  }

  next();
});

app.use((req, res) => {
  res.status(404).json({ error: "Rota não encontrada." });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("================================");
  console.log("VALTRIX V4.1 ONLINE");
  console.log("Porta:", PORT);
  console.log("Banco:", path.join(dataDir, "valtrix.db"));
  console.log("================================");
});
