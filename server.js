const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ===== Config del mundo =====
const WORLD = { width: 4000, height: 4000 };
const TICK_RATE = 30;
const PELLET_COUNT = 600;
const VIRUS_COUNT = 25;
const PELLET_MASS = 1;
const VIRUS_MASS = 100;
const START_MASS = 20;
const MAX_CELLS_PER_PLAYER = 16;
const SPLIT_MIN_MASS = 35;
const EJECT_MIN_MASS = 35;
const EJECT_MASS = 12;
const MERGE_SECONDS = 15;
const TEAM_COLORS = { red: '#ff5252', blue: '#448aff' };
const SKIN_COLORS = [
  '#ff5252', '#ff9100', '#ffc400', '#76ff03',
  '#1de9b6', '#00b0ff', '#7c4dff', '#ff4081',
  '#e040fb', '#69f0ae', '#ffd740', '#40c4ff'
];

// ===== Estado =====
const players = new Map(); // id -> player
const pellets = [];
const viruses = [];
const ejected = []; // masa expulsada
let nextId = 1;

function rand(min, max) { return Math.random() * (max - min) + min; }
function randInt(min, max) { return Math.floor(rand(min, max)); }
function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx*dx + dy*dy; }
function radiusFromMass(m) { return Math.sqrt(m) * 4; }
function speedFromMass(m) { return Math.max(1.2, 8 - Math.log2(m) * 0.55); }

function spawnPellet() {
  pellets.push({
    id: nextId++,
    x: rand(0, WORLD.width),
    y: rand(0, WORLD.height),
    mass: PELLET_MASS,
    color: SKIN_COLORS[randInt(0, SKIN_COLORS.length)],
  });
}

function spawnVirus() {
  viruses.push({
    id: nextId++,
    x: rand(50, WORLD.width - 50),
    y: rand(50, WORLD.height - 50),
    mass: VIRUS_MASS,
  });
}

for (let i = 0; i < PELLET_COUNT; i++) spawnPellet();
for (let i = 0; i < VIRUS_COUNT; i++) spawnVirus();

function createCell(x, y, mass, color) {
  return {
    id: nextId++,
    x, y, mass, color,
    vx: 0, vy: 0,
    mergeAt: Date.now() + MERGE_SECONDS * 1000,
  };
}

function spawnPlayer(player) {
  const x = rand(200, WORLD.width - 200);
  const y = rand(200, WORLD.height - 200);
  player.cells = [createCell(x, y, START_MASS, player.color)];
  player.cells[0].mergeAt = 0;
  player.alive = true;
  player.target = { x, y };
}

let teamToggle = 0;
function assignTeam() {
  const team = teamToggle === 0 ? 'red' : 'blue';
  teamToggle = 1 - teamToggle;
  return team;
}

wss.on('connection', (ws) => {
  const id = nextId++;
  const player = {
    id, ws,
    name: 'Anónimo',
    color: SKIN_COLORS[0],
    mode: 'ffa',
    team: null,
    cells: [],
    target: { x: 0, y: 0 },
    alive: false,
    joined: false,
  };
  players.set(id, player);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      player.name = String(msg.name || 'Anónimo').slice(0, 16);
      player.color = SKIN_COLORS.includes(msg.color) ? msg.color : SKIN_COLORS[0];
      player.mode = msg.mode === 'teams' ? 'teams' : 'ffa';
      if (player.mode === 'teams') {
        player.team = assignTeam();
        player.color = TEAM_COLORS[player.team];
      }
      player.joined = true;
      spawnPlayer(player);
      ws.send(JSON.stringify({
        type: 'init',
        id: player.id,
        world: WORLD,
        team: player.team,
        mode: player.mode,
      }));
    } else if (msg.type === 'input' && player.alive) {
      const tx = Number(msg.x), ty = Number(msg.y);
      if (Number.isFinite(tx) && Number.isFinite(ty)) {
        player.target.x = tx;
        player.target.y = ty;
      }
    } else if (msg.type === 'split' && player.alive) {
      splitPlayer(player);
    } else if (msg.type === 'eject' && player.alive) {
      ejectMass(player);
    } else if (msg.type === 'respawn' && !player.alive && player.joined) {
      spawnPlayer(player);
    }
  });

  ws.on('close', () => {
    players.delete(id);
  });
});

function splitPlayer(player) {
  const newCells = [];
  for (const cell of player.cells) {
    if (player.cells.length + newCells.length >= MAX_CELLS_PER_PLAYER) break;
    if (cell.mass < SPLIT_MIN_MASS) continue;
    const half = cell.mass / 2;
    cell.mass = half;
    const dx = player.target.x - cell.x;
    const dy = player.target.y - cell.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const newCell = createCell(cell.x, cell.y, half, cell.color);
    newCell.vx = ux * 25;
    newCell.vy = uy * 25;
    newCells.push(newCell);
  }
  player.cells.push(...newCells);
}

function ejectMass(player) {
  for (const cell of player.cells) {
    if (cell.mass < EJECT_MIN_MASS) continue;
    const dx = player.target.x - cell.x;
    const dy = player.target.y - cell.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    cell.mass -= EJECT_MASS;
    const r = radiusFromMass(cell.mass);
    ejected.push({
      id: nextId++,
      x: cell.x + ux * (r + 5),
      y: cell.y + uy * (r + 5),
      vx: ux * 18,
      vy: uy * 18,
      mass: EJECT_MASS,
      color: cell.color,
      ownerId: player.id,
    });
  }
}

function clampToWorld(c) {
  const r = radiusFromMass(c.mass);
  if (c.x < r) c.x = r;
  if (c.y < r) c.y = r;
  if (c.x > WORLD.width - r) c.x = WORLD.width - r;
  if (c.y > WORLD.height - r) c.y = WORLD.height - r;
}

function updateCells(dt) {
  // Mover células de jugadores
  for (const p of players.values()) {
    if (!p.alive) continue;
    for (const c of p.cells) {
      // Velocidad por inercia (split/eject)
      c.x += c.vx;
      c.y += c.vy;
      c.vx *= 0.85;
      c.vy *= 0.85;
      if (Math.abs(c.vx) < 0.05) c.vx = 0;
      if (Math.abs(c.vy) < 0.05) c.vy = 0;

      // Mover hacia el target
      const dx = p.target.x - c.x;
      const dy = p.target.y - c.y;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        const sp = speedFromMass(c.mass);
        const step = Math.min(sp, len);
        c.x += (dx / len) * step;
        c.y += (dy / len) * step;
      }

      // Decaimiento de masa lento para evitar acumulación infinita
      if (c.mass > 100) c.mass *= 0.9995;

      clampToWorld(c);
    }

    // Repulsión entre células del mismo jugador si no pueden fusionarse aún
    const now = Date.now();
    for (let i = 0; i < p.cells.length; i++) {
      for (let j = i + 1; j < p.cells.length; j++) {
        const a = p.cells[i], b = p.cells[j];
        const ra = radiusFromMass(a.mass), rb = radiusFromMass(b.mass);
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const overlap = (ra + rb) - d;
        if (overlap > 0) {
          const canMerge = now >= a.mergeAt && now >= b.mergeAt;
          if (canMerge) {
            // Fusionar
            a.mass += b.mass;
            a.x = (a.x * a.mass + b.x * b.mass) / (a.mass + b.mass);
            a.y = (a.y * a.mass + b.y * b.mass) / (a.mass + b.mass);
            p.cells.splice(j, 1);
            j--;
          } else {
            const ux = dx / d, uy = dy / d;
            const push = overlap / 2;
            a.x -= ux * push;
            a.y -= uy * push;
            b.x += ux * push;
            b.y += uy * push;
          }
        }
      }
    }
  }

  // Mover masa expulsada
  for (let i = ejected.length - 1; i >= 0; i--) {
    const e = ejected[i];
    e.x += e.vx;
    e.y += e.vy;
    e.vx *= 0.92;
    e.vy *= 0.92;
    if (Math.abs(e.vx) < 0.1 && Math.abs(e.vy) < 0.1) {
      // Convertir en pellet permanente
      pellets.push({
        id: e.id, x: e.x, y: e.y, mass: e.mass, color: e.color,
      });
      ejected.splice(i, 1);
    }
  }
}

function handleEating() {
  // Pellets
  for (const p of players.values()) {
    if (!p.alive) continue;
    for (const c of p.cells) {
      const r = radiusFromMass(c.mass);
      for (let i = pellets.length - 1; i >= 0; i--) {
        const pl = pellets[i];
        const d = Math.hypot(c.x - pl.x, c.y - pl.y);
        if (d < r) {
          c.mass += pl.mass;
          pellets.splice(i, 1);
        }
      }
    }
  }
  // Mantener número de pellets
  while (pellets.length < PELLET_COUNT) spawnPellet();

  // Virus: solo divide si la célula es lo bastante grande
  for (const p of players.values()) {
    if (!p.alive) continue;
    for (let ci = 0; ci < p.cells.length; ci++) {
      const c = p.cells[ci];
      const r = radiusFromMass(c.mass);
      for (let vi = viruses.length - 1; vi >= 0; vi--) {
        const v = viruses[vi];
        const d = Math.hypot(c.x - v.x, c.y - v.y);
        const vr = radiusFromMass(v.mass);
        if (d < r - vr * 0.3 && c.mass > v.mass * 1.15) {
          // Comer virus y dividir
          c.mass += v.mass;
          viruses.splice(vi, 1);
          // Dividir en pedazos
          const pieces = Math.min(MAX_CELLS_PER_PLAYER - p.cells.length, 4);
          for (let k = 0; k < pieces && c.mass > SPLIT_MIN_MASS; k++) {
            const half = c.mass / 2;
            c.mass = half;
            const angle = Math.random() * Math.PI * 2;
            const nc = createCell(c.x, c.y, half, c.color);
            nc.vx = Math.cos(angle) * 20;
            nc.vy = Math.sin(angle) * 20;
            p.cells.push(nc);
          }
          break;
        }
      }
    }
  }
  while (viruses.length < VIRUS_COUNT) spawnVirus();

  // Jugador come jugador
  const playerList = [...players.values()].filter(p => p.alive);
  for (const a of playerList) {
    for (const ac of a.cells) {
      const ar = radiusFromMass(ac.mass);
      for (const b of playerList) {
        if (a === b) continue;
        // En modo equipos no comer aliados
        if (a.mode === 'teams' && b.mode === 'teams' && a.team === b.team) continue;
        for (let bi = b.cells.length - 1; bi >= 0; bi--) {
          const bc = b.cells[bi];
          const d = Math.hypot(ac.x - bc.x, ac.y - bc.y);
          const br = radiusFromMass(bc.mass);
          if (ac.mass > bc.mass * 1.20 && d < ar - br * 0.4) {
            ac.mass += bc.mass;
            b.cells.splice(bi, 1);
          }
        }
      }
    }
    if (a.cells.length === 0) {
      a.alive = false;
      try {
        a.ws.send(JSON.stringify({ type: 'dead' }));
      } catch {}
    }
  }
}

function broadcast() {
  // Construir snapshot
  const allCells = [];
  for (const p of players.values()) {
    if (!p.alive) continue;
    for (const c of p.cells) {
      allCells.push({
        id: c.id,
        x: Math.round(c.x),
        y: Math.round(c.y),
        m: Math.round(c.mass),
        c: c.color,
        n: p.name,
        pid: p.id,
        t: p.team,
      });
    }
  }
  const allEjected = ejected.map(e => ({
    id: e.id, x: Math.round(e.x), y: Math.round(e.y), m: e.mass, c: e.color,
  }));

  // Leaderboard top 10 (suma de masa por jugador)
  const board = [...players.values()]
    .filter(p => p.alive)
    .map(p => ({
      name: p.name,
      mass: Math.round(p.cells.reduce((s, c) => s + c.mass, 0)),
      team: p.team,
    }))
    .sort((a, b) => b.mass - a.mass)
    .slice(0, 10);

  // Para modo equipos, masa total por equipo
  let teams = null;
  if ([...players.values()].some(p => p.mode === 'teams' && p.alive)) {
    teams = { red: 0, blue: 0 };
    for (const p of players.values()) {
      if (!p.alive || p.mode !== 'teams') continue;
      teams[p.team] += p.cells.reduce((s, c) => s + c.mass, 0);
    }
    teams.red = Math.round(teams.red);
    teams.blue = Math.round(teams.blue);
  }

  // Enviar a cada jugador solo lo visible (área alrededor del jugador)
  for (const p of players.values()) {
    if (p.ws.readyState !== 1) continue;
    let viewX = WORLD.width / 2, viewY = WORLD.height / 2, viewR = 1500;
    if (p.alive && p.cells.length > 0) {
      let cx = 0, cy = 0, tm = 0;
      for (const c of p.cells) { cx += c.x * c.mass; cy += c.y * c.mass; tm += c.mass; }
      viewX = cx / tm; viewY = cy / tm;
      viewR = 600 + Math.sqrt(tm) * 30;
    }
    const visCells = allCells.filter(c =>
      Math.abs(c.x - viewX) < viewR && Math.abs(c.y - viewY) < viewR);
    const visPellets = pellets
      .filter(pl => Math.abs(pl.x - viewX) < viewR && Math.abs(pl.y - viewY) < viewR)
      .map(pl => ({ id: pl.id, x: Math.round(pl.x), y: Math.round(pl.y), m: pl.mass, c: pl.color }));
    const visViruses = viruses
      .filter(v => Math.abs(v.x - viewX) < viewR && Math.abs(v.y - viewY) < viewR)
      .map(v => ({ id: v.id, x: Math.round(v.x), y: Math.round(v.y), m: v.mass }));
    const visEjected = allEjected.filter(e =>
      Math.abs(e.x - viewX) < viewR && Math.abs(e.y - viewY) < viewR);

    try {
      p.ws.send(JSON.stringify({
        type: 'state',
        cells: visCells,
        pellets: visPellets,
        viruses: visViruses,
        ejected: visEjected,
        board,
        teams,
        you: { x: viewX, y: viewY },
      }));
    } catch {}
  }
}

setInterval(() => {
  updateCells(1 / TICK_RATE);
  handleEating();
  broadcast();
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Servidor Agar.io JMR escuchando en puerto ${PORT}`);
});
