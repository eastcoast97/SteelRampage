import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Game, FIXED_DT, MODES, type GameMode, type RosterEntry } from './game/game';
import { CAR_SPECS, BOT_NAMES, type CarSpec } from './game/specs';
import { ARENAS, loadSurfaceTextures } from './game/arena';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { Input } from './core/input';
import { loadCarModels } from './render/carModels';
import { Hud } from './ui/hud';
import { sfx, type EngineKind } from './audio/sfx';
import type { Vehicle } from './game/vehicle';
import { NetClient, GuestSync, serializeSnapshot } from './net/net';

// per-archetype engine audio: sports = screaming exotic, v8 = deep muscle, rally = punchy
const ENGINE_KIND: Record<CarSpec['build'], EngineKind> = {
  speed: 'sports', sports: 'sports', taxi: 'sports',
  muscle: 'rally',
  tank: 'v8', suv: 'v8', ambulance: 'v8', hearse: 'v8',
};

const $ = (id: string) => document.getElementById(id)!;

async function boot() {
  await Promise.all([RAPIER.init(), loadCarModels(), loadSurfaceTextures()]);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  $('app').appendChild(renderer.domElement);

  // --- post-processing: bloom makes neon / turbo / explosions / sun glow ---
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.62,   // strength
    0.5,    // radius
    0.88,   // threshold — only genuinely bright pixels bloom (lit windows,
            // neon, turbo, explosions) — lower values blow out sunlit surfaces
  );
  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  composer.setSize(window.innerWidth, window.innerHeight);
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // --- reflection environment: real PBR reflections on metal + car paint ---
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  function buildEnv(top: string, hor: string): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, top);
    grad.addColorStop(0.46, hor);
    grad.addColorStop(0.54, hor);
    grad.addColorStop(1, '#1a1a22');   // ground bounce
    g.fillStyle = grad; g.fillRect(0, 0, 16, 128);
    // bright horizon band → a specular highlight sweep across car paint & metal
    const band = g.createLinearGradient(0, 56, 0, 72);
    band.addColorStop(0, 'rgba(255,248,232,0)');
    band.addColorStop(0.5, 'rgba(255,250,238,0.85)');
    band.addColorStop(1, 'rgba(255,248,232,0)');
    g.fillStyle = band; g.fillRect(0, 56, 16, 16);
    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    const env = pmrem.fromEquirectangular(tex).texture;
    tex.dispose();
    return env;
  }
  // Poly Haven HDRI reflection environments (CC0): town sunset + docks night.
  // Loaded lazily, PMREM'd once, cached; gradient env is the fallback.
  const hdriEnvs: (THREE.Texture | null | 'loading')[] = [null, null];
  const HDRI_FILES = ['/textures/town_env_1k.hdr', '/textures/docks_env_1k.hdr'];
  const applyEnv = (g: Game) => {
    const idx = g.arenaIdx ?? 0;
    const cached = hdriEnvs[idx];
    if (cached && cached !== 'loading') { g.scene.environment = cached; return; }
    // gradient immediately (so there's never a frame without reflections)…
    g.scene.environment = buildEnv(g.arena.envColors.top, g.arena.envColors.hor);
    if (cached === 'loading') return;
    hdriEnvs[idx] = 'loading';
    new RGBELoader().load(HDRI_FILES[idx], (tex) => {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      const env = pmrem.fromEquirectangular(tex).texture;
      tex.dispose();
      hdriEnvs[idx] = env;
      // …upgraded to the real HDRI as soon as it's ready
      if (game && (game.arenaIdx ?? 0) === idx) game.scene.environment = env;
    }, undefined, () => { hdriEnvs[idx] = null; });
  };

  function renderComposed(scene: THREE.Scene, camera: THREE.Camera) {
    renderPass.scene = scene;
    renderPass.camera = camera;
    composer.render();
  }

  const input = new Input();
  const hud = new Hud();
  let game: Game | null = null;
  let selectedSpec: CarSpec = CAR_SPECS[1];
  let selectedMode: GameMode = 'deathmatch';

  // ---- online state ----
  let net: NetClient | null = null;
  let netRole: 'host' | 'guest' | null = null;
  let lobby: { code: string; players: { id: number; name: string; specId: string; isHost: boolean }[] } | null = null;
  let guestSync: GuestSync | null = null;
  let guestOverShown = false;
  const remoteInputs = new Map<number, any>();      // vehicle idx → latest guest input
  const remoteSpecial = new Set<number>();          // vehicle idx → pending special press
  const idToIdx = new Map<number, number>();        // client id → vehicle idx
  let snapshotAcc = 0;

  const playerName = () =>
    (($('player-name') as HTMLInputElement).value.trim() || 'PLAYER').toUpperCase().slice(0, 12);

  // ---- mode select ----
  const modeSelect = $('mode-select');
  for (const [id, cfg] of Object.entries(MODES) as [GameMode, typeof MODES[GameMode]][]) {
    const card = document.createElement('div');
    card.className = 'mode-card' + (id === selectedMode ? ' selected' : '');
    card.innerHTML = `<h4>${cfg.name}</h4><div class="mdesc">${cfg.desc}</div>`;
    card.addEventListener('click', () => {
      selectedMode = id;
      document.querySelectorAll('.mode-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
    });
    modeSelect.appendChild(card);
  }

  // ---- arena select ----
  let selectedArena = -1;   // -1 = random rotation
  const arenaSelect = $('arena-select');
  const arenaOptions = [
    { idx: -1, name: 'RANDOM', desc: 'map rotation' },
    ...ARENAS.map((a, i) => ({ idx: i, name: a.name, desc: a.desc })),
  ];
  for (const opt of arenaOptions) {
    const card = document.createElement('div');
    card.className = 'mode-card' + (opt.idx === selectedArena ? ' selected' : '');
    card.innerHTML = `<h4>${opt.name}</h4><div class="mdesc">${opt.desc}</div>`;
    card.addEventListener('click', () => {
      selectedArena = opt.idx;
      arenaSelect.querySelectorAll('.mode-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
    });
    arenaSelect.appendChild(card);
  }
  const resolveArena = () => (selectedArena < 0 ? Math.floor(Math.random() * ARENAS.length) : selectedArena);

  // ---- car select ----
  const carSelect = $('car-select');
  const statBar = (v: number) => `<div class="stat-bar"><div style="width:${Math.round(v * 100)}%"></div></div>`;
  for (const spec of CAR_SPECS) {
    const card = document.createElement('div');
    card.className = 'car-card' + (spec === selectedSpec ? ' selected' : '');
    const lum = ((spec.color >> 16) & 0xff) + ((spec.color >> 8) & 0xff) + (spec.color & 0xff);
    const headerColor = lum < 260 ? spec.accent : spec.color;
    card.innerHTML = `
      <h3 style="color:#${headerColor.toString(16).padStart(6, '0')}">${spec.name}</h3>
      <div class="desc">${spec.desc}</div>
      <div class="special-tag">◆ ${spec.specialName}</div>
      <div class="special-desc">${spec.specialDesc}</div>
      <div class="stat">SPEED</div>${statBar(spec.topSpeed / 36)}
      <div class="stat">ARMOR</div>${statBar((100 + spec.armor) / 300)}
      <div class="stat">GRIP</div>${statBar(spec.grip / 7.8)}
    `;
    card.addEventListener('click', () => {
      selectedSpec = spec;
      document.querySelectorAll('.car-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
    });
    carSelect.appendChild(card);
  }

  // ---- lobby UI ----
  function updateLobbyUI() {
    const inLobby = !!lobby;
    $('online-panel').classList.toggle('hidden', inLobby);
    $('lobby').classList.toggle('hidden', !inLobby);
    if (!lobby) return;
    $('lobby-code').textContent = lobby.code;
    $('lobby-players').innerHTML = lobby.players
      .map((p) => `<div class="${p.isHost ? 'lp-host' : ''}">${p.isHost ? '★ ' : ''}${p.name} — ${p.specId.toUpperCase()}</div>`)
      .join('');
    $('lobby-hint').textContent = netRole === 'host'
      ? 'Share the code. Empty slots become bots. Hit ENTER THE ARENA to start.'
      : 'Waiting for the host to start the match… (your car is locked in)';
    $('start-btn').classList.toggle('hidden', netRole === 'guest');
  }

  function setOnlineStatus(msg: string) {
    $('online-status').textContent = msg;
  }

  function leaveLobby(message = '') {
    net?.close();
    net = null;
    netRole = null;
    lobby = null;
    guestSync = null;
    remoteInputs.clear();
    remoteSpecial.clear();
    idToIdx.clear();
    updateLobbyUI();
    setOnlineStatus(message);
    $('start-btn').classList.remove('hidden');
  }

  function wireCommonHandlers(n: NetClient) {
    n.on('error', (m) => setOnlineStatus(m.msg));
    n.on('_closed', () => {
      if (netRole) {
        const wasInGame = !!game && !$('hud').classList.contains('hidden');
        leaveLobby('Connection lost');
        if (wasInGame) quitToMenu();
      }
    });
    n.on('peer-leave', (m) => {
      if (lobby) {
        lobby.players = lobby.players.filter((p) => p.id !== m.id);
        updateLobbyUI();
      }
      if (netRole === 'host' && game && idToIdx.has(m.id)) {
        game.adoptBot(idToIdx.get(m.id)!);   // their car fights on as a bot
        idToIdx.delete(m.id);
      }
    });
  }

  async function hostGame() {
    if (net) return;
    setOnlineStatus('');
    try {
      net = new NetClient();
      wireCommonHandlers(net);
      net.on('created', (m) => {
        net!.id = m.id;
        net!.code = m.code;
        net!.isHost = true;
        netRole = 'host';
        lobby = { code: m.code, players: [{ id: m.id, name: playerName(), specId: selectedSpec.id, isHost: true }] };
        updateLobbyUI();
      });
      net.on('peer-join', (m) => {
        lobby?.players.push({ id: m.id, name: m.name, specId: m.specId, isHost: false });
        updateLobbyUI();
      });
      net.on('input', (m) => {
        const idx = idToIdx.get(m.from);
        if (idx === undefined) return;
        remoteInputs.set(idx, m.d);
        if (m.d.sp) remoteSpecial.add(idx);
      });
      await net.connect();
      net.send({ t: 'create', name: playerName(), specId: selectedSpec.id });
    } catch (err: any) {
      leaveLobby(err.message ?? 'Could not reach the relay server');
    }
  }

  async function joinGame() {
    if (net) return;
    const code = ($('join-code') as HTMLInputElement).value.trim().toUpperCase();
    if (code.length !== 4) return setOnlineStatus('Enter the 4-letter room code');
    setOnlineStatus('');
    try {
      net = new NetClient();
      wireCommonHandlers(net);
      net.on('joined', (m) => {
        net!.id = m.id;
        net!.code = m.code;
        netRole = 'guest';
      });
      net.on('lobby', (m) => {
        lobby = {
          code: net!.code,
          players: m.peers.map((p: any) => ({ id: p.id, name: p.name, specId: p.specId, isHost: p.host })),
        };
        lobby.players.push({ id: net!.id, name: playerName(), specId: selectedSpec.id, isHost: false });
        updateLobbyUI();
      });
      net.on('peer-join', (m) => {
        lobby?.players.push({ id: m.id, name: m.name, specId: m.specId, isHost: false });
        updateLobbyUI();
      });
      net.on('host-left', () => {
        leaveLobby('Host left the game');
        quitToMenu();
      });
      net.on('start', (m) => startGuestMatch(m));
      net.on('state', (m) => {
        guestSync?.onSnapshot(m.s);
        if (guestSync?.gameOver && !guestOverShown) {
          guestOverShown = true;
          showGuestGameOver(guestSync.gameOver);
        }
      });
      await net.connect();
      net.send({ t: 'join', code, name: playerName(), specId: selectedSpec.id });
    } catch (err: any) {
      leaveLobby(err.message ?? 'Could not reach the relay server');
    }
  }

  // ---- match lifecycle ----
  function enterMatchUI() {
    $('menu').classList.add('hidden');
    $('gameover').classList.add('hidden');
    $('pause').classList.add('hidden');
    hud.show();
  }

  function startMatch() {
    sfx.init();
    if (game) game.dispose(renderer);
    guestOverShown = false;

    if (netRole === 'host' && net && lobby) {
      // online: roster = host, guests, then bots to fill 6 seats
      const roster: RosterEntry[] = lobby.players.map((p) => ({ specId: p.specId, name: p.name, human: true }));
      const order: number[] = lobby.players.map((p) => p.id);
      const shuffled = [...CAR_SPECS].sort(() => Math.random() - 0.5);
      let bi = 0;
      while (roster.length < 6) {
        roster.push({ specId: shuffled[bi % shuffled.length].id, name: BOT_NAMES[bi], human: false });
        order.push(-1);
        bi++;
      }
      idToIdx.clear();
      order.forEach((id, idx) => { if (id >= 0) idToIdx.set(id, idx); });
      const arenaIdx = resolveArena();
      game = new Game(selectedSpec, hud, window.innerWidth / window.innerHeight, selectedMode,
        { role: 'host', roster, playerIdx: 0 }, arenaIdx);
      net.send({ t: 'start', roster, mode: selectedMode, skyIdx: game.arena.skyIdx, order, arena: arenaIdx });
    } else {
      game = new Game(selectedSpec, hud, window.innerWidth / window.innerHeight, selectedMode, null, resolveArena());
    }

    applyEnv(game);
    sfx.setEngineProfile(ENGINE_KIND[game.player.spec.build]);
    game.onGameOver = (standings, playerWon, subtitle) => showGameOver(standings, playerWon, subtitle);
    (window as any).__game = game;
    (window as any).__input = input;
    enterMatchUI();
  }

  function startGuestMatch(m: any) {
    sfx.init();
    if (game) game.dispose(renderer);
    guestOverShown = false;
    game = new Game(CAR_SPECS[0], hud, window.innerWidth / window.innerHeight, m.mode,
      { role: 'guest', roster: m.roster, playerIdx: m.myIdx, skyIdx: m.skyIdx }, m.arena ?? 0);
    guestSync = new GuestSync(game, m.myIdx);
    applyEnv(game);
    sfx.setEngineProfile(ENGINE_KIND[game.player.spec.build]);
    (window as any).__guestSync = guestSync;
    (window as any).__game = game;
    (window as any).__input = input;
    enterMatchUI();
  }

  function quitToMenu() {
    if (game) {
      game.dispose(renderer);
      game = null;
      (window as any).__game = null;
    }
    guestSync = null;
    sfx.engineOff();
    hud.hide();
    $('pause').classList.add('hidden');
    $('gameover').classList.add('hidden');
    $('menu').classList.remove('hidden');
    updateLobbyUI();
  }

  function setPaused(p: boolean) {
    if (!game || game.state !== 'playing') return;
    // online matches never freeze the world — ESC is just an overlay
    if (!netRole) game.paused = p;
    $('pause').classList.toggle('hidden', !p);
    if (p) sfx.engineOff();
  }

  function showGameOver(standings: Vehicle[], playerWon: boolean, subtitle: string) {
    hud.hide();
    const title = $('gameover-title');
    title.textContent = playerWon ? 'VICTORY' : 'DESTROYED';
    title.className = playerWon ? 'win' : 'lose';
    $('gameover-subtitle').textContent = subtitle;
    $('final-board').innerHTML = standings
      .map((v, i) => `<div class="row${v === game?.player ? ' me' : ''}"><span>#${i + 1} ${v.name}</span><span>${v.score} kills</span></div>`)
      .join('');
    $('restart-btn').classList.toggle('hidden', netRole === 'guest');
    $('gameover').classList.remove('hidden');
  }

  function showGuestGameOver(over: { order: number[]; scores: number[]; sub: string }) {
    if (!game || !guestSync) return;
    const rows = over.order.map((vi, i) => ({ v: game!.vehicles[vi], score: over.scores[i] }));
    const playerWon = game.vehicles[over.order[0]] === game.player;
    hud.hide();
    const title = $('gameover-title');
    title.textContent = playerWon ? 'VICTORY' : 'DESTROYED';
    title.className = playerWon ? 'win' : 'lose';
    $('gameover-subtitle').textContent = `${over.sub} — waiting for the host to rematch`;
    $('final-board').innerHTML = rows
      .map((r, i) => `<div class="row${r.v === game?.player ? ' me' : ''}"><span>#${i + 1} ${r.v?.name ?? '?'}</span><span>${r.score} kills</span></div>`)
      .join('');
    $('restart-btn').classList.add('hidden');
    $('gameover').classList.remove('hidden');
  }

  $('start-btn').addEventListener('click', startMatch);
  $('restart-btn').addEventListener('click', startMatch);
  $('resume-btn').addEventListener('click', () => setPaused(false));
  $('quit-btn').addEventListener('click', () => {
    if (netRole) leaveLobby();
    quitToMenu();
  });
  $('host-btn').addEventListener('click', hostGame);
  $('join-btn').addEventListener('click', joinGame);
  $('lobby-leave').addEventListener('click', () => leaveLobby());

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    bloomPass.resolution.set(window.innerWidth, window.innerHeight);
    if (game) {
      game.camera.aspect = window.innerWidth / window.innerHeight;
      game.camera.updateProjectionMatrix();
    }
  });

  // ---- main loop ----
  let last = performance.now();
  let lastRenderAt = performance.now();
  let accumulator = 0;
  let frameCount = 0;

  /** authoritative sim advance (offline + online host) — callable from both
   *  rAF and the background ticker so a hidden host tab never freezes guests */
  function simAdvance(now: number) {
    if (!game) return;
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1; // tab-switch guard
    accumulator += dt;
    let ticks = 0;
    while (accumulator >= FIXED_DT) {
      if (netRole === 'host') {
        for (const [idx, d] of remoteInputs) {
          const v = game.vehicles[idx];
          if (!v?.alive) continue;
          v.input.throttle = d.th ?? 0;
          v.input.steer = d.st ?? 0;
          v.input.handbrake = !!d.hb;
          v.input.turbo = !!d.tu;
          v.input.fireMG = !!d.mg;
          v.input.fireMissile = !!d.mi;
          v.input.dropMine = !!d.mn;
          if (remoteSpecial.has(idx)) {
            v.input.special = true;
            remoteSpecial.delete(idx);
          }
        }
      }
      game.step(FIXED_DT, input);
      accumulator -= FIXED_DT;
      ticks++;
    }
    if (netRole === 'host' && ticks > 0) {
      snapshotAcc += ticks;
      if (snapshotAcc >= 3) {   // 60Hz sim → 20Hz snapshots
        snapshotAcc = 0;
        net?.send({ t: 'state', s: serializeSnapshot(game) });
      }
    }
  }

  function frame(now: number) {
    requestAnimationFrame(frame);
    frameCount++;

    if (input.consumeMute()) sfx.toggleMuted();
    if (input.consumePause() && game && game.state === 'playing') setPaused($('pause').classList.contains('hidden'));

    if (!game) { last = now; lastRenderAt = now; return; }
    const rdt = Math.min(0.1, Math.max(0.001, (now - lastRenderAt) / 1000));
    lastRenderAt = now;

    if (netRole === 'guest') {
      last = now;
      // thin client: send inputs, render interpolated host snapshots
      if (frameCount % 2 === 0) {
        net?.send({
          t: 'input',
          d: {
            th: input.throttle, st: input.steer, hb: input.handbrake, tu: input.turbo,
            mg: input.fireMG, mi: input.fireMissile, mn: input.dropMine, sp: input.consumeSpecial(),
          },
        });
      }
      guestSync?.update();
      game.render(rdt);
      renderComposed(game.scene, game.camera);
      return;
    }

    simAdvance(now);
    game.render(rdt);
    renderer.render(game.scene, game.camera);
  }
  requestAnimationFrame(frame);

  // background ticker: a Worker's timer keeps firing when the tab is hidden,
  // so an online HOST keeps simulating + snapshotting for its guests
  const ticker = new Worker(
    URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 50);'], { type: 'text/javascript' })),
  );
  ticker.onmessage = () => {
    if (netRole !== 'host' || !game) return;
    const now = performance.now();
    if (now - last < 45) return;   // rAF is alive — let it drive
    simAdvance(now);
  };
}

boot();
