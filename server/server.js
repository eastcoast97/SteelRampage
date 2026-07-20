// Steel Rampage relay server — room codes + message forwarding only.
// The HOST'S browser runs the authoritative simulation; this server never
// simulates anything, so it stays tiny and cheap to run anywhere.
//
// In production it ALSO serves the built game from dist/ on the same port, so
// the whole thing is one service on one origin (page + wss share a host — no
// mixed-content or CORS setup). Locally, vite serves the page on :5173 and this
// runs the relay on :8787 separately.
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PORT = process.env.PORT || 8787;
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain',
};

// --- static file server (only used when dist/ exists — i.e. production) ---
const httpServer = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  let filePath = path.join(DIST, urlPath);
  // block path traversal
  if (!filePath.startsWith(DIST)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback → index.html
      fs.readFile(path.join(DIST, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('Steel Rampage relay is up. Build the game (npm run build) to serve it here.'); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(idx);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });

/** code → { host, guests: Map<id, ws>, started } */
const rooms = new Map();
let nextId = 1;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
function makeCode() {
  let code = '';
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const send = (ws, obj) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
};

wss.on('connection', (ws) => {
  ws.id = nextId++;
  ws.room = null;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'create') {
      const code = makeCode();
      rooms.set(code, { host: ws, guests: new Map(), started: false });
      ws.room = code;
      ws.isHost = true;
      ws.meta = { name: m.name, specId: m.specId };
      send(ws, { t: 'created', code, id: ws.id });
      return;
    }

    if (m.t === 'join') {
      const room = rooms.get((m.code || '').toUpperCase());
      if (!room) return send(ws, { t: 'error', msg: 'Room not found' });
      if (room.guests.size >= 5) return send(ws, { t: 'error', msg: 'Room is full' });
      ws.room = (m.code || '').toUpperCase();
      ws.isHost = false;
      ws.meta = { name: m.name, specId: m.specId };
      room.guests.set(ws.id, ws);
      send(ws, { t: 'joined', code: ws.room, id: ws.id });
      // current lobby roster for the newcomer + notify everyone else
      const peers = [{ id: room.host.id, name: room.host.meta.name, specId: room.host.meta.specId, host: true }];
      for (const [gid, g] of room.guests) peers.push({ id: gid, name: g.meta.name, specId: g.meta.specId, host: false });
      send(ws, { t: 'lobby', peers });
      const note = { t: 'peer-join', id: ws.id, name: m.name, specId: m.specId };
      send(room.host, note);
      for (const [gid, g] of room.guests) if (gid !== ws.id) send(g, note);
      return;
    }

    const room = rooms.get(ws.room);
    if (!room) return;

    if (m.t === 'start' && ws.isHost) {
      // host provides vehicle order as client ids; tell each guest its index
      room.started = true;
      for (const [gid, g] of room.guests) {
        const myIdx = m.order.indexOf(gid);
        send(g, { t: 'start', roster: m.roster, mode: m.mode, skyIdx: m.skyIdx, myIdx });
      }
      return;
    }

    if (m.t === 'state' && ws.isHost) {
      for (const [, g] of room.guests) send(g, { t: 'state', s: m.s });
      return;
    }

    if (m.t === 'input' && !ws.isHost) {
      send(room.host, { t: 'input', from: ws.id, d: m.d });
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.room);
    if (!room) return;
    if (ws.isHost) {
      for (const [, g] of room.guests) send(g, { t: 'host-left' });
      rooms.delete(ws.room);
    } else {
      room.guests.delete(ws.id);
      send(room.host, { t: 'peer-leave', id: ws.id });
      for (const [, g] of room.guests) send(g, { t: 'peer-leave', id: ws.id });
    }
  });
});

httpServer.listen(PORT, () => {
  const serving = fs.existsSync(DIST);
  console.log(`Steel Rampage on :${PORT} — relay${serving ? ' + game (dist/)' : ' only (no dist/ yet — run npm run build)'}`);
});
