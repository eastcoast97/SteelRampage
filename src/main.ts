import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { Game, FIXED_DT, MODES, type GameMode, type RosterEntry } from './game/game';
import { CAR_SPECS, BOT_NAMES, type CarSpec } from './game/specs';
import { ARENAS, loadSurfaceTextures } from './game/arena';
import { assetUrl } from './assets';
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

/** Loading / match-intro overlay: covers asset loading and the online
 *  handshake, and doubles as the controls reference. Always dwells long
 *  enough to actually be readable. */
const TIPS = [
  'Specials are EARNED — kills and energy cells fill the bar. A 3-kill streak fills it instantly.',
  'Press E with a full bar to open a 45-second window: your special re-fires free until it expires.',
  'Pickup sockets reroll what they hold — that missile spot might be a shield next time.',
  'Shoot the clock tower enough and it comes down. Whoever lands the last hit chooses which way it falls.',
  'Gas pumps go up like bombs. Lead a chasing enemy past the station.',
  'Missiles need a 0.9s lock — break line of sight through a tunnel and the lock dies.',
  'Boost pads chain into the skyway. Hit one at speed for serious airtime.',
  'Land flat after a jump for a perfect-landing boost.',
  'Take the lead by two kills and you get a BOUNTY — everyone can see you, and your killer gets a full special.',
  'When SUDDEN DEATH hits, the ring closes on the town square. Outside it, you burn.',
];
const loading = {
  el: () => $('loading'),
  tipTimer: 0 as any,
  minUntil: 0,
  show(status: string, pct = 0) {
    this.el().classList.remove('hidden');
    $('loading-status').textContent = status;
    $('loading-fill').style.width = `${pct}%`;
    this.minUntil = performance.now() + 1600;   // readable dwell
    const roll = () => { $('loading-tip').textContent = TIPS[Math.floor(Math.random() * TIPS.length)]; };
    roll();
    clearInterval(this.tipTimer);
    this.tipTimer = setInterval(roll, 3600);
  },
  progress(pct: number, status?: string) {
    $('loading-fill').style.width = `${pct}%`;
    if (status) $('loading-status').textContent = status;
  },
  /** resolves once the bar is full AND the minimum dwell has elapsed */
  async done(status = 'READY') {
    this.progress(100, status);
    const wait = Math.max(0, this.minUntil - performance.now());
    await new Promise((r) => setTimeout(r, wait));
    clearInterval(this.tipTimer);
    this.el().classList.add('hidden');
  },
};

async function boot() {
  loading.show('LOADING ASSETS', 8);
  const tracked = <T,>(p: Promise<T>, pct: number, label: string): Promise<T> =>
    p.then((v) => { loading.progress(pct, label); return v; });
  await Promise.all([
    tracked(RAPIER.init(), 35, 'PHYSICS ONLINE'),
    tracked(loadCarModels(), 70, 'VEHICLES LOADED'),
    tracked(loadSurfaceTextures(), 90, 'ARENA SURFACES LOADED'),
  ]);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  $('app').appendChild(renderer.domElement);

  // --- post-processing chain: AO → bloom → tonemap → grade ---
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());

  // Ambient occlusion: contact darkening where surfaces meet (wheel wells,
  // curbs, building bases, under cars). Single biggest "grounded" cue there is.
  // radius is in WORLD units — tuned to vehicle scale (~4m long), not the
  // library default which assumes a small desktop scene.
  const gtaoPass = new GTAOPass(
    new THREE.Scene(), new THREE.PerspectiveCamera(),
    window.innerWidth, window.innerHeight,
  );
  gtaoPass.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: 16 });
  gtaoPass.blendIntensity = 0.85;

  // Bloom runs on the LINEAR HDR buffer (before tonemapping), so the threshold
  // is in scene-light units, not screen units. Those units differ hugely
  // between sky presets: the sunbaked/day sun is 3.2-3.8 intensity, so lit
  // surfaces sit around 2-3 linear and a low threshold turns the whole frame
  // into fog. Night scenes are dark, so emissives (1.5-2.4) stand out on their
  // own. Hence per-preset tuning — matching arena.ts SKY_PRESETS order.
  const BLOOM_BY_SKY: { threshold: number; strength: number }[] = [
    { threshold: 3.0, strength: 0.30 },   // 0 sunbaked — daylight, barely any glow
    { threshold: 2.6, strength: 0.32 },   // 1 day
    { threshold: 0.95, strength: 0.60 },  // 2 night — neon/windows carry the look
    { threshold: 0.90, strength: 0.70 },  // 3 neonNight (docks)
  ];
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    BLOOM_BY_SKY[0].strength, 0.5, BLOOM_BY_SKY[0].threshold,
  );
  const applyBloomForSky = (skyIdx: number) => {
    const b = BLOOM_BY_SKY[skyIdx] ?? BLOOM_BY_SKY[0];
    bloomPass.threshold = b.threshold;
    bloomPass.strength = b.strength;
  };

  // Film grade, applied AFTER tonemapping so the numbers behave predictably:
  // slight S-curve, a touch more colour, cool shadows / warm highlights, vignette.
  const gradePass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      exposure: { value: 1.02 },
      contrast: { value: 1.09 },
      saturation: { value: 1.1 },
      shadowTint: { value: new THREE.Vector3(0.94, 0.97, 1.08) },
      highlightTint: { value: new THREE.Vector3(1.06, 1.01, 0.95) },
      vignette: { value: 0.38 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float exposure, contrast, saturation, vignette;
      uniform vec3 shadowTint, highlightTint;
      varying vec2 vUv;
      void main() {
        vec4 texel = texture2D(tDiffuse, vUv);
        vec3 c = texel.rgb * exposure;
        c = (c - 0.5) * contrast + 0.5;                       // S-curve about mid grey
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, saturation);
        c *= mix(shadowTint, highlightTint, smoothstep(0.0, 0.85, l));  // split tone
        vec2 d = vUv - 0.5;
        c *= clamp(1.0 - dot(d, d) * vignette, 0.0, 1.0);     // vignette
        gl_FragColor = vec4(clamp(c, 0.0, 1.0), texel.a);
      }
    `,
  });

  composer.addPass(renderPass);
  composer.addPass(gtaoPass);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  composer.addPass(gradePass);
  composer.setSize(window.innerWidth, window.innerHeight);
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // debug/tuning handle: toggle passes and tweak grade uniforms live
  (window as any).__fx = { composer, gtaoPass, bloomPass, gradePass, renderPass };

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
  const HDRI_FILES = [assetUrl('textures/town_env_1k.hdr'), assetUrl('textures/docks_env_1k.hdr')];
  const applyEnv = (g: Game) => {
    applyBloomForSky(g.arena.skyIdx);
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
    // the Game (and so its scene/camera) is rebuilt per match — both passes
    // read these per render, so repoint them every frame
    renderPass.scene = scene;
    renderPass.camera = camera;
    gtaoPass.scene = scene;
    gtaoPass.camera = camera as THREE.PerspectiveCamera;
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
        const players = m.peers.map((p: any) => ({ id: p.id, name: p.name, specId: p.specId, isHost: p.host }));
        // the server's roster already contains us — only add ourselves if it
        // somehow doesn't, or we show up twice in our own lobby list
        if (!players.some((p: any) => p.id === net!.id)) {
          players.push({ id: net!.id, name: playerName(), specId: selectedSpec.id, isHost: false });
        }
        lobby = { code: net!.code, players };
        updateLobbyUI();
      });
      net.on('peer-join', (m) => {
        if (lobby && !lobby.players.some((p) => p.id === m.id)) {
          lobby.players.push({ id: m.id, name: m.name, specId: m.specId, isHost: false });
        }
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

  async function startMatch() {
    sfx.init();
    loading.show(netRole === 'host' ? 'STARTING MATCH' : 'ENTERING THE ARENA', 30);
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
    await loading.done('GO');
  }

  async function startGuestMatch(m: any) {
    sfx.init();
    loading.show('CONNECTING TO HOST', 40);
    if (game) game.dispose(renderer);
    guestOverShown = false;
    game = new Game(CAR_SPECS[0], hud, window.innerWidth / window.innerHeight, m.mode,
      { role: 'guest', roster: m.roster, playerIdx: m.myIdx, skyIdx: m.skyIdx }, m.arena ?? 0);
    guestSync = new GuestSync(game, m.myIdx);
    game.enableGuestPrediction();
    applyEnv(game);
    sfx.setEngineProfile(ENGINE_KIND[game.player.spec.build]);
    (window as any).__guestSync = guestSync;
    (window as any).__game = game;
    (window as any).__input = input;
    enterMatchUI();
    // hold the overlay until the host's first snapshot actually lands, so the
    // player never stares at a frozen arena during the handshake
    loading.progress(75, 'SYNCING WITH HOST');
    const started = performance.now();
    while (!guestSync?.ready && performance.now() - started < 15000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await loading.done(guestSync?.ready ? 'GO' : 'HOST NOT RESPONDING');
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
  // post-match: back to the menu (also drops the room, so an online player
  // isn't left sitting in a lobby they've walked away from)
  $('menu-btn').addEventListener('click', () => {
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
          if (d.ts) v.lastInputTs = d.ts;   // echoed in snapshots → guest RTT
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
      // send inputs every frame (tiny payload, halves the upstream delay) and
      // stamp them so the host's echo gives us a live RTT measurement
      net?.send({
        t: 'input',
        d: {
          th: input.throttle, st: input.steer, hb: input.handbrake, tu: input.turbo,
          mg: input.fireMG, mi: input.fireMissile, mn: input.dropMine, sp: input.consumeSpecial(),
          ts: Math.round(performance.now()),
        },
      });
      // predict our own car locally at the sim's fixed timestep, then let the
      // reconciler nudge it toward the host's authoritative state
      let gdt = (now - last) / 1000;
      last = now;
      if (gdt > 0.1) gdt = 0.1;
      accumulator += gdt;
      while (accumulator >= FIXED_DT) {
        game.predictLocal(FIXED_DT, input);
        guestSync?.applyCorrection(FIXED_DT);
        accumulator -= FIXED_DT;
      }
      guestSync?.update();
      game.render(rdt);
      renderComposed(game.scene, game.camera);
      return;
    }

    simAdvance(now);
    game.render(rdt);
    // must match the guest path — plain renderer.render skips bloom entirely
    renderComposed(game.scene, game.camera);
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

  await loading.done('READY');
}

boot();
