(() => {
  const SKINS = [
    '#ff5252', '#ff9100', '#ffc400', '#76ff03',
    '#1de9b6', '#00b0ff', '#7c4dff', '#ff4081',
    '#e040fb', '#69f0ae', '#ffd740', '#40c4ff'
  ];

  // ===== UI: menú =====
  const menu = document.getElementById('menu');
  const deadOverlay = document.getElementById('dead');
  const nameInput = document.getElementById('name');
  const skinsEl = document.getElementById('skins');
  const playBtn = document.getElementById('play');
  const respawnBtn = document.getElementById('respawn');
  const finalMassEl = document.getElementById('finalMass');
  const hud = document.getElementById('hud');
  const massEl = document.getElementById('mass');
  const playersEl = document.getElementById('players');
  const boardEl = document.getElementById('board');
  const teamScoresEl = document.getElementById('teamScores');
  const redScoreEl = document.getElementById('redScore');
  const blueScoreEl = document.getElementById('blueScore');

  let selectedSkin = SKINS[Math.floor(Math.random() * SKINS.length)];
  let selectedMode = 'ffa';

  SKINS.forEach(c => {
    const el = document.createElement('div');
    el.className = 'skin' + (c === selectedSkin ? ' selected' : '');
    el.style.background = c;
    el.dataset.color = c;
    el.addEventListener('click', () => {
      selectedSkin = c;
      skinsEl.querySelectorAll('.skin').forEach(s => s.classList.remove('selected'));
      el.classList.add('selected');
    });
    skinsEl.appendChild(el);
  });

  document.querySelectorAll('.mode').forEach(b => {
    b.addEventListener('click', () => {
      selectedMode = b.dataset.mode;
      document.querySelectorAll('.mode').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    });
  });

  // Restaurar nombre guardado
  nameInput.value = localStorage.getItem('agar_name') || '';

  // ===== Canvas =====
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  // ===== Estado del cliente =====
  let ws = null;
  let myId = null;
  let world = { width: 4000, height: 4000 };
  let myTeam = null;
  let mode = 'ffa';

  // Buffer de snapshots para interpolación (renderizamos ~100ms en el pasado)
  const INTERP_DELAY = 100; // ms
  const snapshots = []; // {t, cells: Map, pellets: Map, viruses: Map, ejected: Map, board, teams, you}
  let lastMeta = { board: [], teams: null, you: { x: 0, y: 0 } };

  let mouse = { x: 0, y: 0 };
  let zoom = 1;

  function snapshotFromMsg(msg) {
    const cells = new Map();
    for (const c of msg.cells) cells.set(c.id, c);
    const pellets = new Map();
    for (const p of msg.pellets) pellets.set(p.id, p);
    const viruses = new Map();
    for (const v of msg.viruses) viruses.set(v.id, v);
    const ejected = new Map();
    for (const e of msg.ejected) ejected.set(e.id, e);
    return {
      t: performance.now(),
      cells, pellets, viruses, ejected,
      board: msg.board, teams: msg.teams, you: msg.you,
    };
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        type: 'join',
        name: (nameInput.value || 'Anónimo').trim(),
        color: selectedSkin,
        mode: selectedMode,
      }));
    });
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'init') {
        myId = msg.id;
        world = msg.world;
        myTeam = msg.team;
        mode = msg.mode;
        menu.classList.add('hidden');
        deadOverlay.classList.add('hidden');
        hud.classList.remove('hidden');
        teamScoresEl.classList.toggle('hidden', mode !== 'teams');
      } else if (msg.type === 'state') {
        snapshots.push(snapshotFromMsg(msg));
        // Mantén solo lo necesario para interpolar
        while (snapshots.length > 6) snapshots.shift();
        lastMeta = { board: msg.board, teams: msg.teams, you: msg.you };
      } else if (msg.type === 'dead') {
        const latest = snapshots[snapshots.length - 1];
        let totalMass = 0;
        if (latest) {
          for (const c of latest.cells.values()) if (c.pid === myId) totalMass += c.m;
        }
        finalMassEl.textContent = `Masa final: ${totalMass}`;
        deadOverlay.classList.remove('hidden');
        hud.classList.add('hidden');
      }
    });
    ws.addEventListener('close', () => {
      ws = null;
      setTimeout(() => {
        // Volver a menú si se cierra
        menu.classList.remove('hidden');
        hud.classList.add('hidden');
      }, 300);
    });
  }

  playBtn.addEventListener('click', () => {
    const name = (nameInput.value || 'Anónimo').trim();
    localStorage.setItem('agar_name', name);
    connect();
  });

  respawnBtn.addEventListener('click', () => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'respawn' }));
    } else {
      connect();
    }
  });

  // ===== Input =====
  canvas.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  let lastInputSent = 0;
  function sendInput() {
    if (!ws || ws.readyState !== 1) return;
    const now = performance.now();
    if (now - lastInputSent < 33) return;
    lastInputSent = now;
    // Convertir mouse a coordenadas del mundo
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const wx = lastMeta.you.x + (mouse.x - cx) / zoom;
    const wy = lastMeta.you.y + (mouse.y - cy) / zoom;
    ws.send(JSON.stringify({ type: 'input', x: wx, y: wy }));
  }

  window.addEventListener('keydown', (e) => {
    if (!ws || ws.readyState !== 1) return;
    if (deadOverlay && !deadOverlay.classList.contains('hidden')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      ws.send(JSON.stringify({ type: 'split' }));
    } else if (e.code === 'KeyW') {
      ws.send(JSON.stringify({ type: 'eject' }));
    }
  });

  // ===== Render =====
  function radiusFromMass(m) { return Math.sqrt(m) * 4; }

  function drawGrid(camX, camY) {
    const step = 50;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    const halfW = canvas.width / (2 * zoom);
    const halfH = canvas.height / (2 * zoom);
    const minX = camX - halfW, maxX = camX + halfW;
    const minY = camY - halfH, maxY = camY + halfH;
    const startX = Math.floor(minX / step) * step;
    const startY = Math.floor(minY / step) * step;

    ctx.beginPath();
    for (let x = startX; x <= maxX; x += step) {
      const sx = (x - camX) * zoom + canvas.width / 2;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, canvas.height);
    }
    for (let y = startY; y <= maxY; y += step) {
      const sy = (y - camY) * zoom + canvas.height / 2;
      ctx.moveTo(0, sy);
      ctx.lineTo(canvas.width, sy);
    }
    ctx.stroke();
  }

  function drawWorldBounds(camX, camY) {
    ctx.strokeStyle = 'rgba(255, 80, 80, 0.5)';
    ctx.lineWidth = 4;
    const x = (0 - camX) * zoom + canvas.width / 2;
    const y = (0 - camY) * zoom + canvas.height / 2;
    ctx.strokeRect(x, y, world.width * zoom, world.height * zoom);
  }

  function worldToScreen(wx, wy, camX, camY) {
    return {
      x: (wx - camX) * zoom + canvas.width / 2,
      y: (wy - camY) * zoom + canvas.height / 2,
    };
  }

  function drawCircle(x, y, r, color, stroke = true) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = Math.max(2, r * 0.06);
      ctx.stroke();
    }
  }

  function drawVirus(x, y, r) {
    const spikes = 16;
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const ang = (i / (spikes * 2)) * Math.PI * 2;
      const rr = i % 2 === 0 ? r : r * 0.82;
      const px = x + Math.cos(ang) * rr;
      const py = y + Math.sin(ang) * rr;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = '#33d17a';
    ctx.fill();
    ctx.strokeStyle = '#1b6e3e';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Interpola un entity entre dos snapshots
  function lerpEntity(a, b, t) {
    return {
      ...b,
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      m: a.m + (b.m - a.m) * t,
    };
  }

  // Devuelve la lista interpolada de entities de un mapa concreto en el tiempo dado
  function interpEntities(getMap, renderTime) {
    if (snapshots.length === 0) return [];
    // Encontrar dos snapshots que rodean renderTime
    let s0 = null, s1 = null;
    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (snapshots[i].t <= renderTime) { s0 = snapshots[i]; s1 = snapshots[i + 1] || null; break; }
    }
    if (!s0) { s0 = snapshots[0]; s1 = snapshots[1] || null; }
    const mapA = getMap(s0);
    const mapB = s1 ? getMap(s1) : mapA;
    if (!s1) return [...mapA.values()];
    const dt = s1.t - s0.t;
    const t = dt > 0 ? Math.max(0, Math.min(1, (renderTime - s0.t) / dt)) : 0;
    const out = [];
    // Entities presentes en B (la siguiente posición conocida) — los preferimos
    for (const [id, eB] of mapB) {
      const eA = mapA.get(id);
      if (eA) out.push(lerpEntity(eA, eB, t));
      else out.push(eB); // nuevo: aparece directamente
    }
    // Entities que sólo están en A (desaparecen pronto): los dibujamos un poco más
    for (const [id, eA] of mapA) {
      if (!mapB.has(id)) out.push(eA);
    }
    return out;
  }

  function render() {
    sendInput();

    const renderTime = performance.now() - INTERP_DELAY;
    const cellsList = interpEntities(s => s.cells, renderTime);
    const pelletsList = interpEntities(s => s.pellets, renderTime);
    const virusesList = interpEntities(s => s.viruses, renderTime);
    const ejectedList = interpEntities(s => s.ejected, renderTime);

    // Cámara: centrar en la masa propia interpolada
    let camX = lastMeta.you.x;
    let camY = lastMeta.you.y;
    let totalMass = 0;
    let myCx = 0, myCy = 0, myMass = 0;
    for (const c of cellsList) {
      if (c.pid === myId) {
        totalMass += c.m;
        myCx += c.x * c.m;
        myCy += c.y * c.m;
        myMass += c.m;
      }
    }
    if (myMass > 0) {
      camX = myCx / myMass;
      camY = myCy / myMass;
    }

    const targetZoom = totalMass > 0
      ? Math.max(0.35, Math.min(1.4, 50 / Math.sqrt(totalMass + 25)))
      : 1;
    zoom += (targetZoom - zoom) * 0.08;

    ctx.fillStyle = '#1f2638';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawGrid(camX, camY);
    drawWorldBounds(camX, camY);

    for (const pl of pelletsList) {
      const s = worldToScreen(pl.x, pl.y, camX, camY);
      drawCircle(s.x, s.y, radiusFromMass(pl.m) * zoom, pl.c, false);
    }

    for (const e of ejectedList) {
      const s = worldToScreen(e.x, e.y, camX, camY);
      drawCircle(s.x, s.y, radiusFromMass(e.m) * zoom, e.c, false);
    }

    for (const v of virusesList) {
      const s = worldToScreen(v.x, v.y, camX, camY);
      drawVirus(s.x, s.y, radiusFromMass(v.m) * zoom);
    }

    cellsList.sort((a, b) => a.m - b.m);
    for (const c of cellsList) {
      const s = worldToScreen(c.x, c.y, camX, camY);
      const r = radiusFromMass(c.m) * zoom;
      drawCircle(s.x, s.y, r, c.c);
      if (r > 18) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 3;
        ctx.font = `bold ${Math.max(12, r * 0.32)}px Segoe UI, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.strokeText(c.n, s.x, s.y - r * 0.12);
        ctx.fillText(c.n, s.x, s.y - r * 0.12);
        ctx.font = `${Math.max(10, r * 0.22)}px Segoe UI, sans-serif`;
        const massLabel = Math.round(c.m);
        ctx.strokeText(massLabel, s.x, s.y + r * 0.25);
        ctx.fillText(massLabel, s.x, s.y + r * 0.25);
      }
    }

    massEl.textContent = `Masa: ${Math.round(totalMass)}`;
    const uniquePlayers = new Set(cellsList.map(c => c.pid));
    playersEl.textContent = `Jugadores: ${uniquePlayers.size}`;

    boardEl.innerHTML = '';
    for (const p of lastMeta.board) {
      const li = document.createElement('li');
      const color = p.team ? (p.team === 'red' ? '#ff5252' : '#448aff') : '#eee';
      li.innerHTML = `<span style="color:${color}">${escapeHtml(p.name)}</span><b>${p.mass}</b>`;
      boardEl.appendChild(li);
    }
    if (lastMeta.teams) {
      redScoreEl.textContent = lastMeta.teams.red;
      blueScoreEl.textContent = lastMeta.teams.blue;
    }

    requestAnimationFrame(render);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  requestAnimationFrame(render);
})();
