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

  // Texto del menú según el dispositivo
  const hintEl = document.getElementById('hint');
  if (hintEl && isTouchDevice) {
    hintEl.textContent = 'Arrastra el dedo · SPLIT para dividir · EJECT para expulsar';
  }

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
  // Última posición de cámara renderizada. La usamos para convertir mouse/touch a mundo
  let camRender = { x: 0, y: 0 };

  // ===== Predicción client-side de células propias =====
  // Espejo de la lógica del servidor para que tu propia célula reaccione al instante
  const ownCellsLocal = new Map(); // id -> { x, y, mass, color, name, steerVx, steerVy, serverX, serverY }
  let lastPredictTime = 0;
  // Constantes que reflejan las del servidor
  const PRED_TURN_RATE = 0.22;
  const PRED_TICK_S = 1 / 30;

  function syncOwnCellsFromSnapshot() {
    if (snapshots.length === 0) return;
    const latest = snapshots[snapshots.length - 1];
    const seen = new Set();
    for (const c of latest.cells.values()) {
      if (c.pid !== myId) continue;
      seen.add(c.id);
      if (!ownCellsLocal.has(c.id)) {
        ownCellsLocal.set(c.id, {
          x: c.x, y: c.y,
          mass: c.m,
          color: c.c,
          name: c.n,
          steerVx: 0, steerVy: 0,
          serverX: c.x, serverY: c.y,
        });
      } else {
        const local = ownCellsLocal.get(c.id);
        local.serverX = c.x;
        local.serverY = c.y;
        local.mass = c.m;     // la masa es siempre autoritativa del servidor
        local.color = c.c;
        local.name = c.n;
      }
    }
    for (const id of [...ownCellsLocal.keys()]) {
      if (!seen.has(id)) ownCellsLocal.delete(id);
    }
  }

  function predictOwnCells(dt) {
    if (ownCellsLocal.size === 0) return;
    const ticks = Math.min(2, dt / PRED_TICK_S);
    // Factor de turn equivalente, decaimiento exponencial
    const turn = 1 - Math.pow(1 - PRED_TURN_RATE, ticks);
    // Factor de reconciliación: ~12% por tick → corrección suave en ~250ms
    const reconcileBlend = 1 - Math.pow(1 - 0.12, ticks);

    // Calcular el target en pantalla → mundo, igual que sendInput
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const offsetX = mouse.x - cx;
    const offsetY = mouse.y - cy;
    const offsetLen = Math.hypot(offsetX, offsetY);
    const inDeadzone = offsetLen < 12;

    for (const cell of ownCellsLocal.values()) {
      // El target se calcula desde la posición ACTUAL de la célula (no de la cámara),
      // pues queremos consistencia con el server
      let targetX, targetY;
      if (inDeadzone) {
        targetX = cell.x;
        targetY = cell.y;
      } else {
        targetX = cell.x + offsetX / zoom;
        targetY = cell.y + offsetY / zoom;
      }

      const sp = Math.max(1.2, 8 - Math.log2(cell.mass) * 0.55);
      const dx = targetX - cell.x;
      const dy = targetY - cell.y;
      const len = Math.hypot(dx, dy);
      let desiredVx = 0, desiredVy = 0;
      if (len > 1) {
        const slow = len < sp * 2 ? len / (sp * 2) : 1;
        desiredVx = (dx / len) * sp * slow;
        desiredVy = (dy / len) * sp * slow;
      }
      cell.steerVx += (desiredVx - cell.steerVx) * turn;
      cell.steerVy += (desiredVy - cell.steerVy) * turn;
      cell.x += cell.steerVx * ticks;
      cell.y += cell.steerVy * ticks;

      // Reconciliación con la posición autoritativa del servidor
      const corrX = cell.serverX - cell.x;
      const corrY = cell.serverY - cell.y;
      const corrLen = Math.hypot(corrX, corrY);
      if (corrLen > 200) {
        // Saltó (split, respawn, virus push, etc.) → snap
        cell.x = cell.serverX;
        cell.y = cell.serverY;
        cell.steerVx = 0;
        cell.steerVy = 0;
      } else if (corrLen > 0.5) {
        cell.x += corrX * reconcileBlend;
        cell.y += corrY * reconcileBlend;
      }

      // Clamp al mundo (igual que el servidor)
      const r = Math.sqrt(cell.mass) * 4;
      if (cell.x < r) cell.x = r;
      if (cell.y < r) cell.y = r;
      if (cell.x > world.width - r) cell.x = world.width - r;
      if (cell.y > world.height - r) cell.y = world.height - r;
    }
  }

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

  // URL del servidor: si estamos dentro de la app (Capacitor/file/etc.) apuntamos a Railway,
  // si no, usamos el mismo host que sirve la web (dev local o Railway directo)
  function getServerWsUrl() {
    const SERVER_HOST = 'agario-jmr-production.up.railway.app';
    // Detectar Capacitor: expone window.Capacitor; además sirve la app desde https://localhost
    const isCapacitor = !!window.Capacitor ||
      (location.protocol === 'https:' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1'));
    const isWeb = (location.protocol === 'http:' || location.protocol === 'https:') && !isCapacitor;
    if (!isWeb) {
      // Capacitor/file/wrapper nativo
      return `wss://${SERVER_HOST}`;
    }
    // En web servida: usar el mismo host (funciona tanto en localhost como en Railway)
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}`;
  }

  let gotInit = false;
  function setPlayBusy(busy, label) {
    playBtn.disabled = busy;
    playBtn.textContent = label || 'Jugar';
    playBtn.classList.toggle('busy', !!busy);
  }
  function connect() {
    gotInit = false;
    setPlayBusy(true, 'Conectando…');
    try {
      ws = new WebSocket(getServerWsUrl());
    } catch (err) {
      setPlayBusy(false, 'Sin conexión, reintenta');
      return;
    }
    // Timeout de seguridad: si en 8s no recibimos `init`, asumimos fallo
    const connectTimeout = setTimeout(() => {
      if (!gotInit) {
        try { ws && ws.close(); } catch {}
        setPlayBusy(false, 'Sin conexión, reintenta');
      }
    }, 8000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        type: 'join',
        name: (nameInput.value || 'Anónimo').trim(),
        color: selectedSkin,
        mode: selectedMode,
      }));
    });
    ws.addEventListener('error', () => {
      // El navegador no expone detalles por seguridad, pero al menos avisamos
      if (!gotInit) setPlayBusy(false, 'Sin conexión, reintenta');
    });
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'init') {
        gotInit = true;
        clearTimeout(connectTimeout);
        setPlayBusy(false);
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
        syncOwnCellsFromSnapshot();
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
        ownCellsLocal.clear();
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
  // Joystick virtual relativo: donde apoyas el dedo se ancla el origen y solo cuenta
  // el desplazamiento. Así el dedo no tapa al player y un pequeño gesto basta.
  let touchAnchor = null;
  let touchCurrent = null;
  const TOUCH_SENSITIVITY = 1.4;

  function applyTouchDelta(t) {
    if (!touchAnchor) return;
    touchCurrent = { x: t.clientX, y: t.clientY };
    const dx = t.clientX - touchAnchor.x;
    const dy = t.clientY - touchAnchor.y;
    mouse.x = canvas.width / 2 + dx * TOUCH_SENSITIVITY;
    mouse.y = canvas.height / 2 + dy * TOUCH_SENSITIVITY;
    touchActive = true;
  }

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    lastTouchAt = performance.now();
    if (e.touches && e.touches.length > 0) {
      const t = e.touches[0];
      touchAnchor = { x: t.clientX, y: t.clientY };
      touchCurrent = { x: t.clientX, y: t.clientY };
      // Al iniciar el toque sin moverse aún → offset 0 → célula quieta
      mouse.x = canvas.width / 2;
      mouse.y = canvas.height / 2;
      touchActive = true;
    }
    if (!hud.classList.contains('hidden')) {
      isTouchDevice = true;
      touchControls.classList.remove('hidden');
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    lastTouchAt = performance.now();
    if (e.touches && e.touches.length > 0) {
      applyTouchDelta(e.touches[0]);
    }
  }, { passive: false });
  canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (!e.touches || e.touches.length === 0) {
      // Al soltar, parar el movimiento → offset = 0 desde el centro
      mouse.x = canvas.width / 2;
      mouse.y = canvas.height / 2;
      touchActive = false;
      touchAnchor = null;
      touchCurrent = null;
    } else {
      // Si quedaba otro dedo, re-anclamos sobre él para evitar saltos
      const t = e.touches[0];
      touchAnchor = { x: t.clientX, y: t.clientY };
      touchCurrent = { x: t.clientX, y: t.clientY };
      mouse.x = canvas.width / 2;
      mouse.y = canvas.height / 2;
    }
  }, { passive: false });
  canvas.addEventListener('touchcancel', (e) => {
    e.preventDefault();
    mouse.x = canvas.width / 2;
    mouse.y = canvas.height / 2;
    touchActive = false;
    touchAnchor = null;
    touchCurrent = null;
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

  function drawCellHalo(x, y, r, color) {
    if (r < 8) return;
    const haloR = r * 1.22;
    const halo = ctx.createRadialGradient(x, y, r * 0.88, x, y, haloR);
    halo.addColorStop(0, rgba(color, 0.32));
    halo.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, haloR, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawCell(x, y, r, color, wobbleSeed, time, wallProx, virusBump) {
    // wallProx = {left, right, top, bottom} con valores 0..1 (0 lejos, 1 tocando)
    const wpL = wallProx ? wallProx.left : 0;
    const wpR = wallProx ? wallProx.right : 0;
    const wpT = wallProx ? wallProx.top : 0;
    const wpB = wallProx ? wallProx.bottom : 0;
    const sqX = Math.max(wpL, wpR);
    const sqY = Math.max(wpT, wpB);
    const SQ_MAX = 0.28;
    const BULGE = 0.16;
    let scaleX = (1 - sqX * SQ_MAX) * (1 + sqY * BULGE);
    let scaleY = (1 - sqY * SQ_MAX) * (1 + sqX * BULGE);

    ctx.save();
    ctx.translate(x, y);
    if (sqX > 0 || sqY > 0) ctx.scale(scaleX, scaleY);

    // Wobble en el contorno para células medianas/grandes; cuando hay bump de virus
    // añadimos una indentación local en la dirección del virus
    const segments = r > 18 ? Math.min(56, Math.max(28, Math.floor(r * 0.8))) : 0;
    if (segments > 0) {
      ctx.beginPath();
      for (let i = 0; i <= segments; i++) {
        const ang = (i / segments) * Math.PI * 2;
        let n =
          Math.sin(ang * 6 + time * 0.003 + wobbleSeed) * 0.010 +
          Math.sin(ang * 3 - time * 0.002 + wobbleSeed * 1.7) * 0.014;
        // Indentación direccional por contacto con un virus
        if (virusBump) {
          const da = ang - virusBump.angle;
          const ca = Math.cos(da);
          if (ca > 0.5) {
            const factor = (ca - 0.5) * 2;
            n -= virusBump.depth * factor * factor;
          }
        }
        const rr = r * (1 + n);
        const px = Math.cos(ang) * rr;
        const py = Math.sin(ang) * rr;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
    }

    const grad = ctx.createRadialGradient(
      -r * 0.35, -r * 0.35, r * 0.05,
      0, 0, r
    );
    grad.addColorStop(0, shade(color, 0.35));
    grad.addColorStop(0.55, color);
    grad.addColorStop(1, shade(color, -0.18));
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.strokeStyle = shade(color, -0.45);
    ctx.lineWidth = Math.max(2, r * 0.07);
    ctx.stroke();
    ctx.restore();
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

  function drawJoystick() {
    if (!touchAnchor || !touchCurrent) return;
    const BASE_R = 56;
    const STICK_R = 26;
    // Limita el stick visualmente al borde de la base para que se vea como joystick real
    const dx = touchCurrent.x - touchAnchor.x;
    const dy = touchCurrent.y - touchAnchor.y;
    const d = Math.hypot(dx, dy);
    const max = BASE_R - STICK_R * 0.4;
    const k = d > max ? max / d : 1;
    const sx = touchAnchor.x + dx * k;
    const sy = touchAnchor.y + dy * k;

    ctx.save();
    // Línea entre base y stick
    if (d > 4) {
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(touchAnchor.x, touchAnchor.y);
      ctx.lineTo(sx, sy);
      ctx.stroke();
    }
    // Base
    ctx.beginPath();
    ctx.arc(touchAnchor.x, touchAnchor.y, BASE_R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Stick
    ctx.beginPath();
    ctx.arc(sx, sy, STICK_R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.30)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
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
    const now = performance.now();
    const dt = lastPredictTime === 0 ? 1 / 60 : Math.min(0.1, (now - lastPredictTime) / 1000);
    lastPredictTime = now;

    sendInput();
    predictOwnCells(dt);

    const renderTime = now - INTERP_DELAY;
    const cellsList = interpEntities(s => s.cells, renderTime);
    const pelletsList = interpEntities(s => s.pellets, renderTime);
    const virusesList = interpEntities(s => s.viruses, renderTime);
    const ejectedList = interpEntities(s => s.ejected, renderTime);

    // Sustituir células propias por las predichas (instant response)
    for (let i = 0; i < cellsList.length; i++) {
      const c = cellsList[i];
      if (c.pid === myId && ownCellsLocal.has(c.id)) {
        const local = ownCellsLocal.get(c.id);
        cellsList[i] = { ...c, x: local.x, y: local.y, m: local.mass };
      }
    }

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

    // Pre-cómputo: proximidad a paredes y a virus por célula (en coordenadas mundo)
    function computeWallProx(c) {
      const rw = radiusFromMass(c.m);
      const range = Math.max(20, rw * 0.6);
      return {
        left: Math.max(0, 1 - (c.x - rw) / range),
        right: Math.max(0, 1 - (world.width - c.x - rw) / range),
        top: Math.max(0, 1 - (c.y - rw) / range),
        bottom: Math.max(0, 1 - (world.height - c.y - rw) / range),
      };
    }
    function computeVirusBump(c) {
      const rw = radiusFromMass(c.m);
      let bump = null;
      for (const v of virusesList) {
        const vr = radiusFromMass(v.m);
        const dx = v.x - c.x, dy = v.y - c.y;
        const d = Math.hypot(dx, dy);
        if (d > 0 && d < rw + vr * 1.05) {
          const overlap = (rw + vr) - d;
          const depth = Math.min(0.30, overlap / Math.max(rw, 1));
          if (depth > 0 && (!bump || depth > bump.depth)) {
            bump = { angle: Math.atan2(dy, dx), depth };
          }
        }
      }
      return bump;
    }
    const cellMeta = cellsList.map(c => ({
      cell: c,
      wp: computeWallProx(c),
      vb: computeVirusBump(c),
    }));

    // Pasada 1: halos (luego cuerpo encima)
    for (const m of cellMeta) {
      const c = m.cell;
      const s = worldToScreen(c.x, c.y, camX, camY);
      const r = radiusFromMass(c.m) * zoom;
      drawCellHalo(s.x, s.y, r, c.c);
    }

    // Pasada 2: cuerpos y etiquetas
    for (const m of cellMeta) {
      const c = m.cell;
      const s = worldToScreen(c.x, c.y, camX, camY);
      const r = radiusFromMass(c.m) * zoom;
      const seed = (c.id * 0.123) % (Math.PI * 2);
      drawCell(s.x, s.y, r, c.c, seed, now, m.wp, m.vb);
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

    drawJoystick();

    requestAnimationFrame(render);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  requestAnimationFrame(render);
})();
