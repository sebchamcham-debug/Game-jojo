'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const MAX_PLAYERS = 20;
const HTML_PATH = path.join(__dirname, 'Battle Royale 3D Multijoueur.html');
const players = new Map();
let nextId = 1;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(HTML_PATH, (err, data) => {
      if (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Impossible de lire le fichier HTML du jeu.');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff'
      });
      res.end(data);
    });
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, players: players.size, maxPlayers: MAX_PLAYERS }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Page introuvable');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function publicPlayer(p) {
  return { id: p.id, name: p.name, skin: p.skin, x: p.x, y: p.y, z: p.z, yaw: p.yaw,
    pitch: p.pitch, hp: p.hp, al: p.al, vx: p.vx, vz: p.vz, weapon: p.weapon, firing: p.firing };
}
function broadcastPlayers() {
  const snapshot = [...players.values()].map(publicPlayer);
  for (const p of players.values()) send(p.ws, { type: 'players', players: snapshot });
}
function boundedNumber(v, fallback, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

wss.on('connection', ws => {
  const p = {
    id: String(nextId++), ws, joined: false, name: 'Joueur', skin: 'ranger',
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, al: true,
    vx: 0, vz: 0, weapon: 0, firing: false, lastHit: 0
  };
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') {
      if (p.joined) return;
      if (players.size >= MAX_PLAYERS) {
        send(ws, { type: 'full' });
        ws.close(1008, 'Server full');
        return;
      }
      p.joined = true;
      p.skin = ['ranger', 'dragonhunter', 'ninja', 'chasseuse'].includes(msg.skin) ? msg.skin : 'ranger';
      p.name = String(msg.name || 'Joueur').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 14) || 'Joueur';
      players.set(p.id, p);
      send(ws, { type: 'welcome', id: p.id, count: players.size, maxPlayers: MAX_PLAYERS });
      broadcastPlayers();
      console.log(`${p.name} rejoint (${players.size}/${MAX_PLAYERS})`);
      return;
    }
    if (!p.joined) return;
    if (msg.type === 'leave') { ws.close(); return; }

    if (msg.type === 'state') {
      if (['ranger', 'dragonhunter', 'ninja', 'chasseuse'].includes(msg.skin)) p.skin = msg.skin;
      p.x = boundedNumber(msg.x, p.x, -300, 300);
      p.y = boundedNumber(msg.y, p.y, -20, 150);
      p.z = boundedNumber(msg.z, p.z, -300, 300);
      p.yaw = boundedNumber(msg.yaw, p.yaw, -100, 100);
      p.pitch = boundedNumber(msg.pitch, p.pitch, -2, 2);
      p.hp = boundedNumber(msg.hp, p.hp, 0, 100);
      p.al = Boolean(msg.al) && p.hp > 0;
      p.vx = boundedNumber(msg.vx, 0, -30, 30);
      p.vz = boundedNumber(msg.vz, 0, -30, 30);
      p.weapon = Math.round(boundedNumber(msg.weapon, 0, 0, 2));
      p.firing = Boolean(msg.firing);
      return;
    }

    if (msg.type === 'hit') {
      const now = Date.now();
      if (!p.al || now - p.lastHit < 90) return;
      const target = players.get(String(msg.target));
      if (!target || target.id === p.id || !target.al) return;
      const distance = Math.hypot(target.x - p.x, target.y - p.y, target.z - p.z);
      if (distance > 190) return;
      p.lastHit = now;
      const maxDamage = [12, 25, 90][Math.round(boundedNumber(msg.weapon, p.weapon, 0, 2))];
      const amount = boundedNumber(msg.amount, maxDamage, 1, maxDamage);
      target.hp = Math.max(0, target.hp - amount);
      target.al = target.hp > 0;
      send(target.ws, { type: 'damage', target: target.id, amount, by: p.name });
      if (!target.al) {
        send(target.ws, { type: 'eliminated', id: target.id, by: p.name });
        send(p.ws, { type: 'kill', by: p.id, target: target.id });
        for (const other of players.values()) {
          if (other.id !== p.id && other.id !== target.id) send(other.ws, { type: 'notice', text: `${p.name} a éliminé ${target.name}` });
        }
      }
      broadcastPlayers();
    }
  });

  ws.on('close', () => {
    if (p.joined && players.delete(p.id)) {
      console.log(`${p.name} quitte (${players.size}/${MAX_PLAYERS})`);
      broadcastPlayers();
    }
  });
  ws.on('error', err => console.warn('WebSocket:', err.message));
});

setInterval(broadcastPlayers, 100);
server.listen(PORT, '0.0.0.0', () => console.log(`Battle Royale multijoueur prêt sur le port ${PORT}`));
