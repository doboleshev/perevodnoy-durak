const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");

const root = __dirname;
const port = Number(process.env.PORT) || 8765;
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, "engine.js"), "utf8"), context);
const Durak = context.Durak;

const rooms = new Map();
let openRoom = null;
let chain = Promise.resolve();
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

function makeRoom() {
  const room = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    tokens: [],
    lastSeen: [],
    rev: 0,
    started: false,
    left: false,
    snapshot: null,
    waiters: [],
  };
  rooms.set(room.id, room);
  return room;
}

function findRoom(token) {
  for (const room of rooms.values()) {
    const seat = room.tokens.indexOf(token);
    if (seat >= 0) return { room, seat };
  }
  return null;
}

function notify(room) {
  const waiters = room.waiters.splice(0);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
}

function withRoom(room, fn) {
  if (room.snapshot) Durak.restore(room.snapshot);
  else Durak.blank();
  const result = fn();
  room.snapshot = Durak.snapshot();
  return result;
}

function publish(room, seat) {
  const view = withRoom(room, () => Durak.viewFor(seat));
  view.rev = room.rev;
  return view;
}

function dropOpen(room) {
  if (openRoom === room) openRoom = null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 100000) {
        reject(new Error("Слишком большой запрос."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function tokenOk(token) {
  return typeof token === "string" && /^[0-9a-f-]{36}$/i.test(token);
}

function touch(room, seat) {
  room.lastSeen[seat] = Date.now();
}

function startMatch(room) {
  withRoom(room, () => Durak.dealMatch());
  room.started = true;
  room.rev += 1;
  notify(room);
}

function sit(token) {
  const existing = findRoom(token);
  if (existing) {
    if (existing.room.left) {
      dropOpen(existing.room);
      rooms.delete(existing.room.id);
    } else {
      touch(existing.room, existing.seat);
      if (!existing.room.started) return { waiting: true, seat: existing.seat };
      return { waiting: false, seat: existing.seat, view: publish(existing.room, existing.seat) };
    }
  }
  if (openRoom && Date.now() - openRoom.lastSeen[0] > 45000) {
    rooms.delete(openRoom.id);
    openRoom = null;
  }
  if (openRoom && openRoom.tokens.length === 1 && !openRoom.left) {
    const room = openRoom;
    room.tokens.push(token);
    room.lastSeen.push(Date.now());
    openRoom = null;
    startMatch(room);
    return { waiting: false, seat: 1, view: publish(room, 1) };
  }
  const room = makeRoom();
  room.tokens.push(token);
  room.lastSeen.push(Date.now());
  openRoom = room;
  return { waiting: true, seat: 0 };
}

function leave(token) {
  const existing = findRoom(token);
  if (!existing) return { ok: true };
  const { room, seat } = existing;
  const partner = room.tokens.find((item, index) => item && index !== seat);
  if (!partner || !room.started) {
    dropOpen(room);
    rooms.delete(room.id);
    notify(room);
    return { ok: true };
  }
  room.tokens[seat] = "";
  room.left = true;
  dropOpen(room);
  room.rev += 1;
  notify(room);
  return { ok: true };
}

function stateOf(token, rev) {
  const existing = findRoom(token);
  if (!existing) return { status: 404, body: { error: "Место за столом не найдено." } };
  const { room, seat } = existing;
  touch(room, seat);
  if (room.left) {
    rooms.delete(room.id);
    dropOpen(room);
    return { status: 200, body: { abandoned: true, rev: room.rev } };
  }
  if (!room.started) return { status: 200, body: { waiting: true, rev: room.rev } };
  return { status: 200, body: { waiting: false, rev: room.rev, view: publish(room, seat), changed: room.rev !== rev } };
}

function move(token, action) {
  const existing = findRoom(token);
  if (!existing) return { status: 404, body: { error: "Место за столом не найдено." } };
  const { room, seat } = existing;
  touch(room, seat);
  if (room.left) return { status: 409, body: { error: "Соперник вышел." } };
  if (!room.started) return { status: 409, body: { error: "Второй игрок ещё не сел." } };
  const result = withRoom(room, () => {
    const before = Durak.snapshot();
    const outcome = Durak.perform(seat, action);
    if (!outcome.ok) Durak.restore(before);
    return outcome;
  });
  if (!result.ok) return { status: 400, body: { error: result.error } };
  room.rev += 1;
  notify(room);
  return { status: 200, body: { view: publish(room, seat) } };
}

function listen(token, rev) {
  let pending = Promise.resolve();
  const registered = enqueue(() => {
    const existing = findRoom(token);
    if (!existing || existing.room.left || existing.room.rev !== rev) return;
    const room = existing.room;
    pending = new Promise((resolve) => {
      const waiter = { resolve };
      waiter.timer = setTimeout(() => {
        room.waiters = room.waiters.filter((item) => item !== waiter);
        resolve();
      }, 20000);
      room.waiters.push(waiter);
    });
  });
  return registered.then(() => pending);
}

function serveFile(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(root, requested));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Не найдено");
      return;
    }
    const type = types[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (!url.pathname.startsWith("/api/")) {
    serveFile(req, res, url);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
    const token = url.searchParams.get("token");
    const rev = Number(url.searchParams.get("rev") || 0);
    if (!tokenOk(token)) {
      send(res, 400, { error: "Нужен ключ игрока." });
      return;
    }
    listen(token, rev)
      .then(() => enqueue(() => stateOf(token, rev)))
      .then((result) => send(res, result.status, result.body))
      .catch(() => {
        if (!res.headersSent) send(res, 500, { error: "Сбой сервера." });
      });
    return;
  }
  enqueue(async () => {
    try {
      if (req.method === "POST" && url.pathname === "/api/sit") {
        const body = await readBody(req);
        if (!tokenOk(body.token)) {
          send(res, 400, { error: "Нужен ключ игрока." });
          return;
        }
        send(res, 200, sit(body.token));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/leave") {
        const body = await readBody(req);
        if (!tokenOk(body.token)) {
          send(res, 400, { error: "Нужен ключ игрока." });
          return;
        }
        send(res, 200, leave(body.token));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/move") {
        const body = await readBody(req);
        if (!tokenOk(body.token)) {
          send(res, 400, { error: "Нужен ключ игрока." });
          return;
        }
        const result = move(body.token, body.action);
        send(res, result.status, result.body);
        return;
      }
      send(res, 404, { error: "Неизвестный запрос." });
    } catch (error) {
      if (!res.headersSent) send(res, 400, { error: "Запрос не разобран." });
    }
  }).catch(() => {
    if (!res.headersSent) send(res, 500, { error: "Сбой сервера." });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`ready http://127.0.0.1:${port}`);
});
