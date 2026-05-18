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
  const touchControls = document.getElementById('touchControls');
  const btnSplit = document.getElementById('btnSplit');
  const btnEject = document.getElementById('btnEject');

  function detectTouch() {
    return ('ontouchstart' in window) ||
      (navigator.maxTouchPoints > 0) ||
      window.matchMedia('(pointer: coarse)').matches ||
      window.innerWidth < 768;
  }
  let isTouchDevice = detectTouch();

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
    // Re-evaluar dispositivo táctil en caso de cambio de viewport
    if (detectTouch()) {
      isTouchDevice = true;
      if (!hud.classList.contains('hidden')) {
        touchControls.classList.remove('hidden');
      }
    }
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

  // Iniciar en el centro: con eso el target = centro de la célula → quieta hasta que el usuario mueva
  let mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  let touchActive = false;
  let zoom = 1;
  let wakeLock = null;
  // Última posición de cámara renderizada (interpolada). La usamos para convertir mouse/touch a mundo
  let camRender = { x: 0, y: 0 };

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
        // Siempre mostrar los botones en partida; en desktop también sirven y refuerzan la UX
        touchControls.classList.remove('hidden');
        requestWakeLock();
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
        touchControls.classList.add('hidden');
        releaseWakeLock();
      }
    });
    ws.addEventListener('close', () => {
      ws = null;
      releaseWakeLock();
      touchControls.classList.add('hidden');
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
  let lastTouchAt = 0; // timestamp del último evento táctil; ignora ratón por 500ms tras un touch
  canvas.addEventListener('mousemove', (e) => {
    if (performance.now() - lastTouchAt < 500) return;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  let lastInputSent = 0;
  function sendInput() {
    if (!ws || ws.readyState !== 1) return;
    const now = performance.now();
    if (now - lastInputSent < 20) return;
    lastInputSent = now;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const offsetX = mouse.x - cx;
    const offsetY = mouse.y - cy;
    const offsetLen = Math.hypot(offsetX, offsetY);

    // Zona muerta: si el cursor/dedo está muy cerca del centro,
    // mandamos un target estable (posición autoritativa del servidor)
    // para que la célula pare sin oscilar.
    if (offsetLen < 12) {
      ws.send(JSON.stringify({ type: 'input', x: lastMeta.you.x, y: lastMeta.you.y }));
      return;
    }

    // Movimiento normal: convertir usando la cámara renderizada (responsive)
    const wx = camRender.x + offsetX / zoom;
    const wy = camRender.y + offsetY / zoom;
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

  // ===== Input táctil =====
  function updateTouch(e) {
    lastTouchAt = performance.now();
    if (e.touches && e.touches.length > 0) {
      const t = e.touches[0];
      mouse.x = t.clientX;
      mouse.y = t.clientY;
      touchActive = true;
    }
  }
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    updateTouch(e);
    // Si el primer touch ocurre, garantizamos que se muestren los botones
    if (!hud.classList.contains('hidden')) {
      isTouchDevice = true;
      touchControls.classList.remove('hidden');
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    updateTouch(e);
  }, { passive: false });
  canvas.addEventListener('touchend', (e) => {
    e.preventDefault(); // evita que el navegador dispare mousemove/mousedown fantasma
    if (!e.touches || e.touches.length === 0) {
      // Al soltar, parar el movimiento → target = centro de la pantalla = centro de la célula
      mouse.x = canvas.width / 2;
      mouse.y = canvas.height / 2;
      touchActive = false;
    } else {
      updateTouch(e);
    }
  }, { passive: false });
  canvas.addEventListener('touchcancel', (e) => {
    e.preventDefault();
    mouse.x = canvas.width / 2;
    mouse.y = canvas.height / 2;
    touchActive = false;
  }, { passive: false });

  // Botones flotantes de acción
  function sendAction(type) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type }));
    }
  }
  btnSplit.addEventListener('pointerdown', (e) => { e.preventDefault(); sendAction('split'); });
  btnEject.addEventListener('pointerdown', (e) => { e.preventDefault(); sendAction('eject'); });
  // Evitar que un toque sobre los botones también dispare touchstart del canvas
  for (const btn of [btnSplit, btnEject]) {
    btn.addEventListener('touchstart', e => e.stopPropagation());
  }

  // ===== Wake lock (mantener pantalla encendida durante la partida) =====
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch {}
  }
  function releaseWakeLock() {
    try { wakeLock && wakeLock.release(); } catch {}
    wakeLock = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !hud.classList.contains('hidden')) {
      requestWakeLock();
    }
  });

  // ===== Render =====
  function radiusFromMass(m) { return Math.sqrt(m) * 4; }

  function drawGrid(camX, camY) {
    const step = 50;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
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

  // ===== Helpers de color =====
  function hexToRgb(hex) {
    const c = hex.replace('#', '');
    return {
      r: parseInt(c.substr(0, 2), 16),
      g: parseInt(c.substr(2, 2), 16),
      b: parseInt(c.substr(4, 2), 16),
    };
  }
  function shade(hex, amount) {
    // amount > 0: clarear; amount < 0: oscurecer
    const { r, g, b } = hexToRgb(hex);
    const ch = (v) => Math.max(0, Math.min(255, Math.round(
      v + (amount > 0 ? (255 - v) * amount : v * amount)
    )));
    return `rgb(${ch(r)}, ${ch(g)}, ${ch(b)})`;
  }
  function rgba(hex, a) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  function drawCell(x, y, r, color, wobbleSeed, time) {
    // Wobble en el contorno para células medianas/grandes
    const segments = r > 18 ? Math.min(48, Math.max(24, Math.floor(r * 0.7))) : 0;
    if (segments > 0) {
      ctx.beginPath();
      for (let i = 0; i <= segments; i++) {
        const ang = (i / segments) * Math.PI * 2;
        const n =
          Math.sin(ang * 6 + time * 0.003 + wobbleSeed) * 0.010 +
          Math.sin(ang * 3 - time * 0.002 + wobbleSeed * 1.7) * 0.014;
        const rr = r * (1 + n);
        const px = x + Math.cos(ang) * rr;
        const py = y + Math.sin(ang) * rr;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }

    // Gradiente radial con highlight desplazado arriba-izquierda
    const grad = ctx.createRadialGradient(
      x - r * 0.35, y - r * 0.35, r * 0.05,
      x, y, r
    );
    grad.addColorStop(0, shade(color, 0.35));
    grad.addColorStop(0.55, color);
    grad.addColorStop(1, shade(color, -0.18));
    ctx.fillStyle = grad;
    ctx.fill();

    // Borde tintado (versión oscura del propio color)
    ctx.strokeStyle = shade(color, -0.45);
    ctx.lineWidth = Math.max(2, r * 0.07);
    ctx.stroke();
  }

  function drawPellet(x, y, r, color) {
    // Halo
    if (r > 1.5) {
      const halo = ctx.createRadialGradient(x, y, r * 0.4, x, y, r * 2.6);
      halo.addColorStop(0, rgba(color, 0.45));
      halo.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, r * 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // Pellet
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    // Highlight superior
    if (r > 2.5) {
      ctx.beginPath();
      ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.fill();
    }
  }

  function drawEjected(x, y, r, color) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
    g.addColorStop(0, shade(color, 0.30));
    g.addColorStop(1, shade(color, -0.20));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = shade(color, -0.40);
    ctx.lineWidth = Math.max(1.5, r * 0.08);
    ctx.stroke();
  }

  function drawVirus(x, y, r, time) {
    const spikes = 18;
    // Pulso suave del radio
    const pulse = 1 + Math.sin(time * 0.002) * 0.015;
    const R = r * pulse;
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const ang = (i / (spikes * 2)) * Math.PI * 2;
      const rr = i % 2 === 0 ? R : R * 0.80;
      const px = x + Math.cos(ang) * rr;
      const py = y + Math.sin(ang) * rr;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    const grad = ctx.createRadialGradient(x - R * 0.3, y - R * 0.3, R * 0.1, x, y, R);
    grad.addColorStop(0, '#5fe39a');
    grad.addColorStop(0.6, '#33d17a');
    grad.addColorStop(1, '#1f8b54');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = '#0f5530';
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
    camRender.x = camX;
    camRender.y = camY;

    const targetZoom = totalMass > 0
      ? Math.max(0.35, Math.min(1.4, 50 / Math.sqrt(totalMass + 25)))
      : 1;
    zoom += (targetZoom - zoom) * 0.08;

    // Fondo: gradiente radial centrado + vignette
    const bgGrad = ctx.createRadialGradient(
      canvas.width / 2, canvas.height / 2, 0,
      canvas.width / 2, canvas.height / 2, Math.max(canvas.width, canvas.height) * 0.7
    );
    bgGrad.addColorStop(0, '#2a3148');
    bgGrad.addColorStop(0.7, '#1a1f2e');
    bgGrad.addColorStop(1, '#0c0f18');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawGrid(camX, camY);
    drawWorldBounds(camX, camY);

    const now = performance.now();

    for (const pl of pelletsList) {
      const s = worldToScreen(pl.x, pl.y, camX, camY);
      drawPellet(s.x, s.y, radiusFromMass(pl.m) * zoom, pl.c);
    }

    for (const e of ejectedList) {
      const s = worldToScreen(e.x, e.y, camX, camY);
      drawEjected(s.x, s.y, radiusFromMass(e.m) * zoom, e.c);
    }

    // Células primero, virus después → las células pasan por DEBAJO de los virus
    cellsList.sort((a, b) => a.m - b.m);
    for (const c of cellsList) {
      const s = worldToScreen(c.x, c.y, camX, camY);
      const r = radiusFromMass(c.m) * zoom;
      // Seed estable basado en el id para que el wobble sea coherente por célula
      const seed = (c.id * 0.123) % (Math.PI * 2);
      drawCell(s.x, s.y, r, c.c, seed, now);
      if (r > 18) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.lineWidth = Math.max(3, r * 0.06);
        ctx.font = `700 ${Math.max(13, r * 0.34)}px "Segoe UI", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = Math.max(4, r * 0.12);
        ctx.shadowOffsetY = 2;
        ctx.strokeText(c.n, s.x, s.y - r * 0.13);
        ctx.fillText(c.n, s.x, s.y - r * 0.13);
        ctx.font = `600 ${Math.max(11, r * 0.22)}px "Segoe UI", system-ui, sans-serif`;
        const massLabel = Math.round(c.m);
        ctx.strokeText(massLabel, s.x, s.y + r * 0.27);
        ctx.fillText(massLabel, s.x, s.y + r * 0.27);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
      }
    }

    // Virus al final, por encima de las células
    for (const v of virusesList) {
      const s = worldToScreen(v.x, v.y, camX, camY);
      drawVirus(s.x, s.y, radiusFromMass(v.m) * zoom, now);
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
