import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { buildArena, type ArenaData } from './arena';
import { Vehicle } from './vehicle';
import { BotController } from './bots';
import { PickupManager, PICKUP_COLORS, type PickupType } from './pickups';
import { PedManager } from './peds';
import { CAR_SPECS, BOT_NAMES, type CarSpec } from './specs';
import { buildCarMesh, makeContactShadow } from '../render/carMesh';
import { Effects } from '../render/effects';
import { Hud } from '../ui/hud';
import { sfx } from '../audio/sfx';
import type { Input } from '../core/input';

export const FIXED_DT = 1 / 60;

export type GameMode = 'deathmatch' | 'survival' | 'timed';

export interface RosterEntry { specId: string; name: string; human: boolean }

export interface NetOpts {
  role: 'host' | 'guest';
  roster: RosterEntry[];
  playerIdx: number;
  skyIdx?: number;
}

export const MODES: Record<GameMode, { name: string; desc: string; scoreLimit?: number; lives?: number; timeLimit?: number }> = {
  deathmatch: { name: 'DEATHMATCH', desc: 'First to 15 kills wins', scoreLimit: 15 },
  survival: { name: 'SURVIVAL', desc: '3 lives. Last wreck rolling wins', lives: 3 },
  timed: { name: 'TIME ATTACK', desc: 'Most kills in 3 minutes', timeLimit: 180 },
};

// ---- damage hierarchy (raw, pre-mitigation, vs the universal 100 pool) ----
// MAX: locked missile 34 > dumbfire 26.  MID: specials, hard-capped at
// SPECIAL_CAP per activation per victim.  MIN: MG chip damage.  Rams ≤ RAM_CAP.
const MG_COOLDOWN = 0.095;
const MG_RANGE = 68;
const MG_DAMAGE = 2.2;
const MISSILE_DAMAGE_LOCKED = 34;
const MISSILE_DAMAGE_DUMB = 26;
const MISSILE_RADIUS = 7;
const MISSILE_COOLDOWN = 1.1;
const MINE_DAMAGE = 24;
const MINE_RADIUS = 5.5;
const BARREL_DAMAGE = 24;
const BARREL_RADIUS = 6.5;
const SPECIAL_CAP = 29;          // 0.85 × locked missile — specials can never exceed it
const RAM_CAP = 18;
const SLAM_DAMAGE = 22;
const FLAME_DPS = 20;
const TURRET_SHOT = 2.0;
const MINIGUN_SHOT = 3.5;
const BOMB_DAMAGE = 29;
const DASH_BASE = 12;

// pedestrians: high-risk recovery — chase-speed gate + per-vehicle cooldown
const PED_HEAL = 4;
const PED_HEAL_COOLDOWN = 2.5;
const PED_HEAL_MIN_SPEED = 12;

// boost pads
const PAD_BOOST = 10;           // Δv per pad hit
const PAD_MAX_SPEED_MULT = 1.45;
const PAD_COOLDOWN = 1.2;

// ---- missile lock-on: cone acquisition with hysteresis ----
const LOCK_RANGE = 78;          // R: detection radius (m)
const LOCK_CONE = 0.8;          // cos θ — 36.9° half-angle acquisition cone
const LOCK_TIME = 0.9;          // seconds in-cone to acquire
const LOCK_DECAY = 3.0;         // progress lost per second out of cone (full reset in 0.33s)
const LOCK_KEEP_RANGE = 86;     // retention is forgiving so edge wiggle doesn't strobe
const LOCK_KEEP_CONE = 0.72;

interface Missile {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: Vehicle | null;
  owner: Vehicle;
  life: number;
  mesh: THREE.Group;
  smokeAcc: number;
  dead: boolean;
}

interface Mine {
  pos: THREE.Vector3;
  owner: Vehicle;
  armTime: number;   // counts down; owner-safe until well past this
  ownerSafe: number;
  life: number;
  mesh: THREE.Group;
  glowMat: THREE.MeshStandardMaterial;
  dead: boolean;
}

interface RemoteBomb {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  owner: Vehicle;
  landed: boolean;
  timer: number;
  mesh: THREE.Group;
  fuseMat: THREE.MeshStandardMaterial;
  ring: THREE.Mesh;
  dead: boolean;
}

interface Barrel {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  mesh: THREE.Group;
  home: THREE.Vector3;
  alive: boolean;
  respawnTimer: number;
  fuse: number; // > 0 → detonating soon (chain reactions)
  /** gas pumps: fixed super-barrels — bigger blast, longer respawn */
  isPump?: boolean;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

let hexFieldTexture: THREE.CanvasTexture | null = null;

/** thin hex lattice on transparent ground — the shield's surface pattern */
function makeHexFieldTexture(): THREE.CanvasTexture {
  if (hexFieldTexture) return hexFieldTexture;
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(200, 215, 255, 0.85)';
  g.lineWidth = 1.6;
  const r = 17;
  const w = r * Math.sqrt(3);
  for (let row = -1; row < 256 / (r * 1.5) + 1; row++) {
    for (let col = -1; col < 512 / w + 1; col++) {
      const cx = col * w + (row % 2 ? w / 2 : 0);
      const cy = row * r * 1.5;
      g.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        i === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
      }
      g.closePath();
      g.stroke();
    }
  }
  hexFieldTexture = new THREE.CanvasTexture(c);
  hexFieldTexture.wrapS = hexFieldTexture.wrapT = THREE.RepeatWrapping;
  return hexFieldTexture;
}

export class Game {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  /** which ARENAS entry this match runs on (radar + layout selection) */
  arenaIdx = 0;
  /** the marked score leader — killing them grants a full special bar */
  bountyTarget: Vehicle | null = null;
  private bountyMarker: THREE.Mesh | null = null;
  /** SUDDEN DEATH: a kill-ring shrinks toward the town square late in the
   *  match — outside it you burn. Infinity = not active. */
  suddenDeathR = Infinity;
  private sdStartTime = 0;
  private sdNextTick = 0;
  private sdWall: THREE.Mesh | null = null;
  /** CLOCK TOWER COLLAPSE — once per match: shoot it down, crush the square */
  private towerHP = 200;
  towerState: 'standing' | 'warning' | 'falling' | 'down' = 'standing';
  private towerTimer = 0;
  towerFallT = 0;
  towerDir = new THREE.Vector3(1, 0, 0);
  private towerPivot: THREE.Group | null = null;
  world: RAPIER.World;
  arena: ArenaData;
  effects: Effects;
  hud: Hud;
  pickups: PickupManager;
  peds: PedManager;
  mode: GameMode;

  vehicles: Vehicle[] = [];
  player: Vehicle;
  bots: BotController[] = [];
  missiles: Missile[] = [];
  mines: Mine[] = [];
  barrels: Barrel[] = [];
  bombs: RemoteBomb[] = [];
  private colliderToVehicle = new Map<number, Vehicle>();
  private colliderToBarrel = new Map<number, Barrel>();
  private eventQueue: RAPIER.EventQueue;
  private ramCooldowns = new Map<string, number>();

  state: 'playing' | 'over' = 'playing';
  paused = false;
  /** online: events accumulated since the last snapshot (host drains them) */
  netEvents: any[] = [];
  netOpts: NetOpts | null = null;
  private denyCooldown = 0;
  /** aggregates player-dealt damage per victim into one popup per 0.25s */
  private pendingDmg = new Map<Vehicle, { sum: number; t: number }>();
  private heartbeatT = 0;
  private prevTurboOn = false;
  private hpSprites = new Map<Vehicle, { sprite: THREE.Sprite; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; lastHp: number }>();
  private shadowBlobs = new Map<Vehicle, THREE.Mesh>();
  private wallHitCooldowns = new Map<Vehicle, number>();
  private missileAlarmT = 0;
  private turboLerp = 0;
  // skid marks: fixed pool, oldest recycled
  private skids: THREE.Mesh[] = [];
  private skidCursor = 0;
  private lastSkidAt = new Map<Vehicle, THREE.Vector3>();
  timeLeft = 0;
  onGameOver: ((standings: Vehicle[], playerWon: boolean, subtitle: string) => void) | null = null;

  private time = 0;
  private wasLocked = false;
  private camPos = new THREE.Vector3();
  private camInit = false;
  private fov = 70;

  constructor(playerSpec: CarSpec, hud: Hud, aspect: number, mode: GameMode = 'deathmatch', netOpts: NetOpts | null = null, arenaIdx = 0) {
    this.hud = hud;
    this.mode = mode;
    this.netOpts = netOpts;
    this.arenaIdx = arenaIdx;
    this.timeLeft = MODES[mode].timeLimit ?? 0;
    this.camera = new THREE.PerspectiveCamera(70, aspect, 0.1, 800);
    this.world = new RAPIER.World({ x: 0, y: -25, z: 0 });
    this.world.timestep = FIXED_DT;
    this.eventQueue = new RAPIER.EventQueue(true);

    this.arena = buildArena(this.world, this.scene, netOpts?.skyIdx, arenaIdx);
    this.effects = new Effects(this.scene);

    const sp = this.arena.spawnPoints;
    if (netOpts) {
      // online: spawn the agreed roster in order; humans have no bot controller
      netOpts.roster.forEach((entry, i) => {
        const spec = CAR_SPECS.find((s) => s.id === entry.specId) ?? CAR_SPECS[0];
        const point = sp[i % sp.length];
        const v = this.spawnVehicle(spec, point.pos, point.yaw, entry.name, !entry.human, undefined);
        // host simulates bots; guests just render everyone
        if (!entry.human && netOpts.role === 'host') this.bots.push(new BotController(v));
      });
      this.player = this.vehicles[netOpts.playerIdx] ?? this.vehicles[0];
    } else {
      this.player = this.spawnVehicle(playerSpec, sp[0].pos, sp[0].yaw, 'YOU', false, undefined);
      // bots drive a shuffled set of distinct vehicles (their real colors — identity matters)
      const shuffled = [...CAR_SPECS].sort(() => Math.random() - 0.5);
      for (let i = 0; i < 5; i++) {
        const spec = shuffled[i % shuffled.length];
        const point = sp[(i + 1) % sp.length];
        const v = this.spawnVehicle(spec, point.pos, point.yaw, BOT_NAMES[i], true, undefined);
        this.bots.push(new BotController(v));
      }
    }

    const lives = MODES[mode].lives ?? 0;
    for (const v of this.vehicles) v.lives = lives;

    this.pickups = new PickupManager(this.scene, this.arena.pickupPoints);
    this.peds = new PedManager(this.scene, this.arena.pedZones);
    this.spawnBarrels();

    // skid-mark pool (oldest marks recycle — no per-frame material churn)
    const skidMat = new THREE.MeshBasicMaterial({ color: 0x141218, transparent: true, opacity: 0.5, depthWrite: false });
    const skidGeo = new THREE.PlaneGeometry(0.26, 0.9);
    for (let i = 0; i < 240; i++) {
      const s = new THREE.Mesh(skidGeo, skidMat);
      s.rotation.x = -Math.PI / 2;
      s.visible = false;
      this.scene.add(s);
      this.skids.push(s);
    }
  }

  private spawnVehicle(spec: CarSpec, pos: THREE.Vector3, yaw: number, name: string, isBot: boolean, color?: number): Vehicle {
    const v = new Vehicle(this.world, spec, pos, yaw, name, isBot);
    const { group, wheels } = buildCarMesh(spec, color);
    v.mesh = group;
    v.wheels = wheels;
    // shield: hex-cell energy field hugging the car (mostly invisible —
    // the hex lattice reads on the rim, flares white when it eats a hit)
    const bubble = new THREE.Mesh(
      new THREE.SphereGeometry(spec.size.z * 1.55, 24, 16),
      new THREE.MeshBasicMaterial({
        map: makeHexFieldTexture(), color: 0x8fa5ff,
        transparent: true, opacity: 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    bubble.scale.y = 0.55;      // squashed dome — a field, not a floating ball
    bubble.position.y = 0.15;
    bubble.visible = false;
    group.add(bubble);
    v.shieldMesh = bubble;
    this.scene.add(group);
    this.vehicles.push(v);
    this.colliderToVehicle.set(v.collider.handle, v);
    v.collider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    // ground-projected AO contact shadow (fades + expands with altitude)
    const blob = makeContactShadow(spec.size.x, spec.size.z);
    this.scene.add(blob);
    this.shadowBlobs.set(v, blob);

    // stunt landings: perfect = boost + toast; heavy = rumble + thud
    v.onLanding = (veh, perfect, fallSpeed) => {
      if (perfect) {
        const fwd = veh.forward;
        const p = veh.position.addScaledVector(fwd, -veh.spec.size.z);
        p.y += 0.3;
        for (let i = 0; i < 8; i++) this.effects.turboFlame(p, fwd.clone().multiplyScalar(-1));
        if (veh === this.player) {
          this.hud.toast('PERFECT LANDING — BOOST', '#ffe44d');
          sfx.pickup();
        }
      }
      if (fallSpeed > 10 && veh === this.player) {
        this.effects.trauma = Math.min(1, this.effects.trauma + Math.min(0.45, fallSpeed * 0.035));
        sfx.thud(Math.min(1, fallSpeed / 16));
      }
    };

    v.onDamage = (victim, amount, attacker) => {
      if (attacker === this.player && victim !== this.player) {
        const e = this.pendingDmg.get(victim) ?? { sum: 0, t: 0 };
        e.sum += amount;
        this.pendingDmg.set(victim, e);
      }
      // online: forward human-dealt damage so guests get their own popups
      if (this.netOpts?.role === 'host' && attacker && !attacker.isBot && attacker !== this.player && attacker !== victim) {
        this.netEvents.push({ k: 'dmg', ai: this.vehicles.indexOf(attacker), vi: this.vehicles.indexOf(victim), amt: Math.round(amount) });
      }
    };
    // floating over-vehicle health bar (all non-self vehicles online, bots offline)
    if (isBot || this.netOpts) {
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 16;
      const tex = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      sprite.scale.set(2.4, 0.3, 1);   // sizeAttenuation shrinks it with distance
      sprite.visible = false;
      this.scene.add(sprite);
      this.hpSprites.set(v, { sprite, canvas, tex, lastHp: -1 });
    }
    return v;
  }

  private drawHpSprite(entry: { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture }, ratio: number) {
    const g = entry.canvas.getContext('2d')!;
    g.clearRect(0, 0, 128, 16);
    g.fillStyle = 'rgba(8, 8, 14, 0.75)';
    g.fillRect(0, 0, 128, 16);
    const color = ratio > 0.5 ? '#2ee86c' : ratio > 0.25 ? '#ffb300' : '#ff3b30';
    for (let i = 0; i < 10; i++) {
      const segFill = Math.max(0, Math.min(1, ratio * 10 - i));
      g.fillStyle = 'rgba(255,255,255,0.14)';
      g.fillRect(3 + i * 12.3, 3, 10, 10);
      if (segFill > 0) {
        g.fillStyle = color;
        g.fillRect(3 + i * 12.3, 3, 10 * segFill, 10);
      }
    }
    entry.tex.needsUpdate = true;
  }

  private spawnBarrels() {
    for (const home of this.arena.barrelPoints) {
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(home.x, home.y, home.z).setAngularDamping(1.0),
      );
      const collider = this.world.createCollider(
        RAPIER.ColliderDesc.cylinder(0.85, 0.55).setDensity(0.4).setFriction(0.6),
        body,
      );
      const mesh = new THREE.Group();
      const barrelMat = new THREE.MeshStandardMaterial({ color: 0xb03020, roughness: 0.6, metalness: 0.3 });
      const stripeMat = new THREE.MeshStandardMaterial({
        color: 0xffcc33, emissive: 0xff8800, emissiveIntensity: 0.5, roughness: 0.5,
      });
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.7, 12), barrelMat);
      b.castShadow = true;
      const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.26, 12), stripeMat);
      stripe.position.y = 0.35;
      mesh.add(b, stripe);
      this.scene.add(mesh);
      const barrel: Barrel = { body, collider, mesh, home: home.clone(), alive: true, respawnTimer: 0, fuse: 0 };
      this.barrels.push(barrel);
      this.colliderToBarrel.set(collider.handle, barrel);
    }
    // gas pumps: FIXED shootable super-barrels at the station — big blast,
    // chains the barrel cluster around them
    for (const home of this.arena.pumpPoints) {
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(home.x, home.y, home.z),
      );
      const collider = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.45, 0.9, 0.35).setFriction(0.6), body,
      );
      const mesh = new THREE.Group();
      const bodyMat = new THREE.MeshStandardMaterial({ color: 0xc23018, roughness: 0.55, metalness: 0.3 });
      const pump = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.7, 0.6), bodyMat);
      pump.position.y = 0;
      pump.castShadow = true;
      const screen = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 0.4, 0.05),
        new THREE.MeshStandardMaterial({ color: 0xd8e8e0, emissive: 0x88ffcc, emissiveIntensity: 0.5 }),
      );
      screen.position.set(0, 0.35, 0.31);
      const hose = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.04, 0.7, 6),
        new THREE.MeshStandardMaterial({ color: 0x17151d, roughness: 0.9 }),
      );
      hose.position.set(0.42, 0.1, 0);
      hose.rotation.z = 0.35;
      mesh.add(pump, screen, hose);
      mesh.position.set(home.x, home.y, home.z);
      this.scene.add(mesh);
      const barrel: Barrel = { body, collider, mesh, home: home.clone(), alive: true, respawnTimer: 0, fuse: 0, isPump: true };
      this.barrels.push(barrel);
      this.colliderToBarrel.set(collider.handle, barrel);
    }
  }

  /** fixed timestep simulation */
  step(dt: number, input: Input) {
    if (this.state !== 'playing' || this.paused) return;
    this.time += dt;

    if (this.player.alive) {
      this.player.input.throttle = input.throttle;
      this.player.input.steer = input.steer;
      this.player.input.handbrake = input.handbrake;
      this.player.input.turbo = input.turbo;
      this.player.input.fireMG = input.fireMG;
      this.player.input.fireMissile = input.fireMissile;
      this.player.input.dropMine = input.dropMine;
      this.player.input.special = input.consumeSpecial();
      if (input.consumeFlip()) this.player.unflip();

      // never fail silently: shake the ammo chip when firing on empty
      this.denyCooldown = Math.max(0, this.denyCooldown - dt);
      if (this.denyCooldown <= 0) {
        if (input.fireMissile && this.player.missiles <= 0) {
          this.hud.deny('missile');
          this.denyCooldown = 0.6;
        } else if (input.dropMine && this.player.minesAmmo <= 0) {
          this.hud.deny('mine');
          this.denyCooldown = 0.6;
        }
      }
    }

    for (const b of this.bots) b.update(dt, this.vehicles, this.player, this.pickups, this.world, this.suddenDeathR);
    for (const v of this.vehicles) this.updateLock(v, dt);

    this.updateBoostPads(dt);
    this.updateBounty();
    this.updateSuddenDeath();
    this.updateTower(dt);

    for (const v of this.vehicles) {
      if (!v.alive) {
        if (!v.eliminated) {
          v.respawnTimer -= dt;
          if (v.respawnTimer <= 0) this.respawn(v);
        }
        continue;
      }
      v.update(dt, this.world);
      if (v.input.fireMG && v.mgCooldown <= 0) this.fireMG(v);
      if (v.input.fireMissile && v.missileCooldown <= 0 && v.missiles > 0) this.fireMissile(v);
      if (v.input.dropMine && v.mineCooldown <= 0 && v.minesAmmo > 0) this.dropMine(v);
      this.handleSpecial(v, dt);
      if (v.position.y < -8) this.respawn(v);
    }

    this.updateMissiles(dt);
    this.updateMines(dt);
    this.updateBombs(dt);
    this.updateBarrels(dt);
    this.pickups.update(dt, this.vehicles, (v, type) => this.collectPickup(v, type));
    this.peds.update(dt, this.vehicles, (v, pos) => this.onPedSplat(v, pos));

    this.world.step(this.eventQueue);
    this.handleCollisions(dt);

    this.checkWinCondition(dt);
  }

  private checkWinCondition(dt: number) {
    const cfg = MODES[this.mode];
    if (this.mode === 'deathmatch') {
      for (const v of this.vehicles) {
        if (v.score >= (cfg.scoreLimit ?? 15)) {
          this.endMatch(v === this.player, v === this.player ? 'You reached 15 kills' : `${v.name} reached 15 kills`);
          return;
        }
      }
    } else if (this.mode === 'timed') {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) {
        this.timeLeft = 0;
        const top = [...this.vehicles].sort((a, b) => b.score - a.score)[0];
        this.endMatch(this.player.score >= top.score, 'Time is up');
      }
    } else {
      // survival
      const remaining = this.vehicles.filter((v) => !v.eliminated);
      if (remaining.length <= 1) {
        const winner = remaining[0];
        this.endMatch(winner === this.player, winner ? `${winner === this.player ? 'You are' : winner.name + ' is'} the last one rolling` : 'Everyone is wrecked');
      } else if (this.player.eliminated) {
        const place = remaining.length + 1;
        this.endMatch(false, `Wrecked out — ${place}${place === 2 ? 'nd' : place === 3 ? 'rd' : 'th'} place`);
      }
    }
  }

  private endMatch(playerWon: boolean, subtitle: string) {
    this.state = 'over';
    sfx.engineOff();
    const standings = [...this.vehicles].sort((a, b) => b.score - a.score);
    if (this.netOpts?.role === 'host') {
      this.netEvents.push({
        k: 'over',
        order: standings.map((v) => this.vehicles.indexOf(v)),
        scores: standings.map((v) => v.score),
        sub: subtitle,
      });
    }
    this.onGameOver?.(standings, playerWon, subtitle);
  }

  /** true if nothing solid blocks the line from v to e */
  private hasLOS(v: Vehicle, e: Vehicle, dist: number, dir: THREE.Vector3): boolean {
    const pos = v.position;
    const ray = new RAPIER.Ray(
      { x: pos.x, y: pos.y + 0.6, z: pos.z },
      { x: dir.x, y: dir.y, z: dir.z },
    );
    const hit = this.world.castRay(ray, dist - 1, true, undefined, undefined, undefined, v.body);
    if (!hit) return true;
    const hitV = this.colliderToVehicle.get(hit.collider.handle);
    return hitV === e || this.colliderToBarrel.has(hit.collider.handle);
  }

  /** cone-acquisition lock-on state machine (see LOCK_* constants) */
  private updateLock(v: Vehicle, dt: number) {
    if (!v.alive) {
      v.lockTarget = null;
      v.lockCandidate = null;
      v.lockProgress = 0;
      return;
    }
    const pos = v.position;
    const fwd = v.forward;

    // LOCKED state is sticky: retention uses the wider hysteresis cone
    if (v.lockProgress >= 1 && v.lockCandidate?.alive) {
      _v1.copy(v.lockCandidate.position).sub(pos);
      const dist = _v1.length();
      _v1.normalize();
      if (dist <= LOCK_KEEP_RANGE && fwd.dot(_v1) >= LOCK_KEEP_CONE && this.hasLOS(v, v.lockCandidate, dist, _v1)) {
        v.lockTarget = v.lockCandidate;
        return;
      }
    }

    // ACQUIRING: best candidate inside the strict cone with line of sight
    let best: Vehicle | null = null;
    let bestScore = -Infinity;
    for (const e of this.vehicles) {
      if (e === v || !e.alive) continue;
      _v1.copy(e.position).sub(pos);
      const dist = _v1.length();
      if (dist > LOCK_RANGE) continue;
      _v1.normalize();
      const dot = fwd.dot(_v1);
      if (dot < LOCK_CONE) continue;
      if (!this.hasLOS(v, e, dist, _v1)) continue;
      const score = dot * 2 - dist / LOCK_RANGE;
      if (score > bestScore) { bestScore = score; best = e; }
    }

    if (best) {
      if (v.lockCandidate !== best) {
        v.lockCandidate = best;   // new candidate — start acquisition over
        v.lockProgress = 0;
      }
      v.lockProgress = Math.min(1, v.lockProgress + dt / LOCK_TIME);
    } else {
      // out of cone/range: rapid decay
      v.lockProgress = Math.max(0, v.lockProgress - dt * LOCK_DECAY);
      if (v.lockProgress <= 0) v.lockCandidate = null;
    }
    v.lockTarget = v.lockProgress >= 1 && v.lockCandidate?.alive ? v.lockCandidate : null;
  }

  private mgDamage(v: Vehicle) {
    return MG_DAMAGE * (v.overdriveTime > 0 ? 1.75 : 1);
  }

  private fireMG(v: Vehicle) {
    const minigun = v.spec.specialId === 'minigun' && v.specialActiveTime > 0;
    v.mgCooldown = minigun ? MG_COOLDOWN / 3 : MG_COOLDOWN;
    v.spawnProtection = 0; // firing drops your shield
    const pos = v.position;
    const fwd = v.forward;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(v.quaternion);
    const muzzle = _v1.copy(pos).addScaledVector(fwd, v.spec.size.z + 0.4).addScaledVector(up, 0.4).clone();

    const dir = _v2.copy(fwd);
    if (v.lockTarget) {
      _v3.copy(v.lockTarget.position).setY(v.lockTarget.position.y + 0.2).sub(muzzle).normalize();
      if (fwd.dot(_v3) > 0.9) dir.copy(_v3);
    }
    let spread = v.isBot ? 0.075 : 0.03;
    if (minigun) spread *= 2;
    dir.x += (Math.random() - 0.5) * spread;
    dir.y += (Math.random() - 0.5) * spread;
    dir.z += (Math.random() - 0.5) * spread;
    dir.normalize();

    const ray = new RAPIER.Ray(
      { x: muzzle.x, y: muzzle.y, z: muzzle.z },
      { x: dir.x, y: dir.y, z: dir.z },
    );
    const hit = this.world.castRay(ray, MG_RANGE, true, undefined, undefined, undefined, v.body);
    let end: THREE.Vector3;
    if (hit) {
      const toi = (hit as any).timeOfImpact ?? (hit as any).toi;
      end = muzzle.clone().addScaledVector(dir, toi);
      const victim = this.colliderToVehicle.get(hit.collider.handle);
      const barrel = this.colliderToBarrel.get(hit.collider.handle);
      if (victim && victim.alive) {
        // minigun mode draws from the special budget; once the cap is spent,
        // shots revert to base MG damage (it's still the default weapon)
        let shot = this.mgDamage(v);
        if (minigun) {
          const boosted = this.drawSpecialBudget(v, victim, MINIGUN_SHOT);
          shot = boosted > 0 ? boosted : MG_DAMAGE;
        }
        const killed = victim.takeDamage(shot, v, this.time);
        victim.body.applyImpulse({ x: dir.x * 0.25 * victim.body.mass(), y: 0, z: dir.z * 0.25 * victim.body.mass() }, true);
        this.effects.sparks(end, 4);
        if (v === this.player) this.hud.showHitmarker();
        if (victim === this.player) {
          this.hud.showDamage(0.12);
          this.effects.trauma = Math.min(1, this.effects.trauma + 0.05);
        }
        if (killed) this.onKill(v, victim);
        if (victim === this.player || v === this.player) sfx.hit();
      } else if (barrel && barrel.alive && barrel.fuse <= 0) {
        barrel.fuse = 0.001; // shot barrels pop immediately
        (barrel as any).igniter = v;
        this.effects.sparks(end, 5, 0xffaa44);
      } else if (this.arena.towerBody && hit.collider.parent()?.handle === this.arena.towerBody.handle) {
        this.damageTower(4, v);   // structure takes double MG
        this.effects.sparks(end, 3, 0xd0b090);
      } else {
        this.effects.sparks(end, 2, 0xcccccc);
      }
    } else {
      end = muzzle.clone().addScaledVector(dir, MG_RANGE);
    }
    this.effects.tracer(muzzle, end, minigun ? 0xff7733 : v.overdriveTime > 0 ? 0xff55ee : 0xffd070);
    if (v === this.player) sfx.shoot();
    else if (v.position.distanceTo(this.player.position) < 38 && Math.random() < 0.5) sfx.shoot();
  }

  private fireMissile(v: Vehicle) {
    v.missiles--;
    v.missileCooldown = MISSILE_COOLDOWN;
    v.spawnProtection = 0;
    const fwd = v.forward;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(v.quaternion);
    // launch low (bumper height) so point-blank shots can't skim over the target's roof
    const pos = v.position.addScaledVector(fwd, v.spec.size.z + 0.8).addScaledVector(up, 0.35);

    // same design language as the pickup: sleek hull, swept fins, thruster plume
    const mesh = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.13, 0.85, 10),
      new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.3, metalness: 0.65 }),
    );
    body.rotation.x = Math.PI / 2;
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.13, 0.36, 10),
      new THREE.MeshStandardMaterial({ color: 0xff6a1a, emissive: 0xff4400, emissiveIntensity: 0.7, roughness: 0.35 }),
    );
    nose.rotation.x = -Math.PI / 2;
    nose.position.z = -0.6;
    mesh.add(body, nose);
    const finMat = new THREE.MeshStandardMaterial({ color: 0x22202a, roughness: 0.55, metalness: 0.5 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.26, 0.16), finMat);
      fin.position.set(Math.cos(a) * 0.16, Math.sin(a) * 0.16, 0.32);
      fin.rotation.z = a + Math.PI / 2;
      mesh.add(fin);
    }
    const plume = new THREE.Mesh(
      new THREE.ConeGeometry(0.09, 0.42, 8),
      new THREE.MeshBasicMaterial({ color: 0xff8830, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    plume.rotation.x = -Math.PI / 2;
    plume.position.z = 0.66;
    mesh.add(plume);
    mesh.position.copy(pos);
    this.scene.add(mesh);

    this.missiles.push({
      pos: pos.clone(),
      vel: fwd.clone().multiplyScalar(Math.max(22, v.forwardSpeed + 14)),
      target: v.lockTarget,
      owner: v,
      life: 5,
      mesh,
      smokeAcc: 0,
      dead: false,
    });
    if (v === this.player || v.position.distanceTo(this.player.position) < 50) sfx.missileLaunch();
  }

  private updateMissiles(dt: number) {
    for (const m of this.missiles) {
      if (m.dead) continue;
      m.life -= dt;
      if (m.life <= 0) { this.explodeMissile(m, m.pos); continue; }

      const speed = Math.min(46, m.vel.length() + 55 * dt);
      const dir = _v1.copy(m.vel).normalize();
      if (m.target && m.target.alive) {
        _v2.copy(m.target.position).setY(m.target.position.y + 0.2).sub(m.pos).normalize();
        const turnRate = 3.0;
        const angle = dir.angleTo(_v2);
        if (angle > 0.0001) {
          const t = Math.min(1, (turnRate * dt) / angle);
          dir.lerp(_v2, t).normalize();
        }
      }
      m.vel.copy(dir).multiplyScalar(speed);

      const prev = _v3.copy(m.pos);
      const stepLen = speed * dt;
      m.pos.addScaledVector(dir, stepLen);

      // proximity fuse — catches point-blank and near-miss geometry the ray can skim past
      let boom = false;
      for (const v of this.vehicles) {
        if (v === m.owner || !v.alive) continue;
        if (v.position.distanceToSquared(m.pos) < 2.3 * 2.3) {
          this.explodeMissile(m, m.pos.clone());
          boom = true;
          break;
        }
      }
      if (boom) continue;

      const ray = new RAPIER.Ray(
        { x: prev.x, y: prev.y, z: prev.z },
        { x: dir.x, y: dir.y, z: dir.z },
      );
      const hit = this.world.castRay(ray, stepLen + 0.6, true, undefined, undefined, undefined, m.owner.body);
      if (hit) {
        const toi = (hit as any).timeOfImpact ?? (hit as any).toi;
        const at = prev.clone().addScaledVector(dir, toi);
        this.explodeMissile(m, at);
        continue;
      }

      m.mesh.position.copy(m.pos);
      m.mesh.lookAt(_v2.copy(m.pos).add(dir));
      m.smokeAcc += dt;
      while (m.smokeAcc > 0.016) {
        m.smokeAcc -= 0.016;
        this.effects.smokeTrail(m.pos);
      }
    }
    this.missiles = this.missiles.filter((m) => !m.dead);
  }

  private explodeMissile(m: Missile, at: THREE.Vector3) {
    m.dead = true;
    this.scene.remove(m.mesh);
    // locked missiles hit harder — locking on is the skill being rewarded
    const base = m.target ? MISSILE_DAMAGE_LOCKED : MISSILE_DAMAGE_DUMB;
    const dmg = base * (m.owner.overdriveTime > 0 ? 1.5 : 1);
    this.explosionAt(at, dmg, MISSILE_RADIUS, m.owner, false);
  }

  private dropMine(v: Vehicle) {
    v.minesAmmo--;
    v.mineCooldown = 0.6;
    v.spawnProtection = 0;
    this.spawnMineFrom(v);
  }

  private spawnMineFrom(v: Vehicle) {
    const back = v.forward.multiplyScalar(-1);
    const pos = v.position.addScaledVector(back, v.spec.size.z + 1.2);
    pos.y = Math.max(0.28, pos.y - 0.8);

    const glowMat = new THREE.MeshStandardMaterial({
      color: 0xff3322, emissive: 0xff2200, emissiveIntensity: 1.2, roughness: 0.4,
    });
    const mesh = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.5, 0.22, 10),
      new THREE.MeshStandardMaterial({ color: 0x2a2730, roughness: 0.6, metalness: 0.4 }),
    );
    const bump = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), glowMat);
    bump.position.y = 0.16;
    mesh.add(base, bump);
    mesh.position.copy(pos);
    this.scene.add(mesh);

    this.mines.push({
      pos: pos.clone(), owner: v,
      armTime: 0.7, ownerSafe: 2.0,
      life: 40, mesh, glowMat, dead: false,
    });
    if (v === this.player) sfx.hit();
  }

  private updateMines(dt: number) {
    for (const m of this.mines) {
      if (m.dead) continue;
      m.armTime -= dt;
      m.ownerSafe -= dt;
      m.life -= dt;
      if (m.life <= 0) { m.dead = true; this.scene.remove(m.mesh); continue; }
      if (m.armTime > 0) continue;
      for (const v of this.vehicles) {
        if (!v.alive) continue;
        if (v === m.owner && m.ownerSafe > 0) continue;
        if (v.position.distanceToSquared(m.pos) < 2.4 * 2.4) {
          m.dead = true;
          this.scene.remove(m.mesh);
          this.explosionAt(m.pos, MINE_DAMAGE, MINE_RADIUS, m.owner, false);
          break;
        }
      }
    }
    this.mines = this.mines.filter((m) => !m.dead);
  }

  // ================= per-vehicle special weapons =================

  private handleSpecial(v: Vehicle, dt: number) {
    const id = v.spec.specialId;

    // activation
    if (v.input.special) {
      if (id === 'bomb' && v.bombOut) {
        // second press = detonate
        const bomb = this.bombs.find((b) => b.owner === v && !b.dead);
        if (bomb) this.detonateBomb(bomb);
      } else if (v.specialEnergy >= 1 && v.specialActiveTime <= 0) {
        if (id === 'repair' && v.health >= v.spec.maxHealth) {
          // don't burn the charge on a full tank
          if (v === this.player) this.hud.toast('ARMOR ALREADY FULL', '#8a7f96');
        } else {
          v.specialEnergy = 0;
          v.spawnProtection = 0;
          this.activateSpecial(v);
          if (v === this.player) this.hud.toast(v.spec.specialName + '!', '#ff9ef2');
        }
      } else if (v === this.player && v.specialActiveTime <= 0) {
        // never fail silently — tell the player why nothing happened
        this.hud.toast(`CHARGING ${Math.floor(v.specialEnergy * 100)}%`, '#8a7f96');
      }
      v.input.special = false;
    }

    // active effects per step
    if (v.specialActiveTime > 0) {
      if (id === 'dash') this.tickDash(v, dt);
      else if (id === 'flame') this.tickFlame(v, dt);
      else if (id === 'turret') this.tickTurret(v, dt);
      else if (id === 'minetrail') this.tickMineTrail(v, dt);
    }
  }

  /** meter out special damage: each activation may deal at most SPECIAL_CAP
   *  raw damage to any single victim. Returns the granted amount. */
  private drawSpecialBudget(attacker: Vehicle, victim: Vehicle, raw: number): number {
    const used = attacker.specialLedger.get(victim) ?? 0;
    const granted = Math.min(raw, Math.max(0, SPECIAL_CAP - used));
    if (granted > 0) attacker.specialLedger.set(victim, used + granted);
    return granted;
  }

  private activateSpecial(v: Vehicle) {
    v.specialLedger.clear(); // fresh damage budget per activation
    const id = v.spec.specialId;
    if (id === 'dash') {
      v.specialActiveTime = 1.8;
      sfx.missileLaunch();
    } else if (id === 'minigun') {
      v.specialActiveTime = 4;
      if (v === this.player) sfx.hit();
    } else if (id === 'flame') {
      v.specialActiveTime = 3.2;
    } else if (id === 'turret') {
      v.specialActiveTime = 5;
      v.turretTimer = 0;
    } else if (id === 'slam') {
      this.doSlam(v);
    } else if (id === 'bomb') {
      this.launchBomb(v);
    } else if (id === 'repair') {
      v.health = Math.min(v.spec.maxHealth, v.health + 45);
      this.effects.sparks(v.position, 22, 0x3aff6e);
      if (v === this.player) sfx.pickup();
    } else if (id === 'minetrail') {
      v.specialActiveTime = 0.65;
      v.turretTimer = 0; // reuse as drop cadence
    }
    // hard design invariant: NO special may stay active longer than 45s
    // (bombs self-detonate at 4s; this guards future specials too)
    v.specialActiveTime = Math.min(v.specialActiveTime, 45);
  }

  private tickMineTrail(v: Vehicle, dt: number) {
    v.turretTimer -= dt;
    if (v.turretTimer > 0) return;
    v.turretTimer = 0.22;
    this.spawnMineFrom(v);
  }

  private tickDash(v: Vehicle, dt: number) {
    // brute-force forward shove on top of normal drive forces
    const fwd = v.forward;
    const push = v.spec.accel * 1.4 * v.body.mass() * dt;
    v.body.applyImpulse({ x: fwd.x * push, y: 0, z: fwd.z * push }, true);
    const back = fwd.clone().multiplyScalar(-1);
    const p = v.position.addScaledVector(back, v.spec.size.z + 0.3);
    p.y += 0.3;
    this.effects.turboFlame(p, back);
    this.effects.turboFlame(p, back);
  }

  private tickFlame(v: Vehicle, dt: number) {
    const pos = v.position;
    const fwd = v.forward;
    const nozzle = pos.clone().addScaledVector(fwd, v.spec.size.z + 0.5);
    nozzle.y += 0.5;
    this.effects.flameCone(nozzle, fwd);

    for (const e of this.vehicles) {
      if (e === v || !e.alive) continue;
      _v1.copy(e.position).sub(pos);
      const dist = _v1.length();
      if (dist > 13) continue;
      if (fwd.dot(_v1.normalize()) < 0.8) continue;
      const dmg = this.drawSpecialBudget(v, e, FLAME_DPS * dt);
      if (dmg <= 0) continue;
      const killed = e.takeDamage(dmg, v, this.time);
      if (e === this.player) this.hud.showDamage(0.03);
      if (killed) this.onKill(v, e);
    }
    // cook barrels caught in the cone
    for (const b of this.barrels) {
      if (!b.alive || b.fuse > 0) continue;
      const t = b.body.translation();
      _v1.set(t.x - pos.x, 0, t.z - pos.z);
      if (_v1.length() < 12 && fwd.dot(_v1.normalize()) > 0.8) {
        b.fuse = 0.25 + Math.random() * 0.2;
        (b as any).igniter = v;
      }
    }
  }

  private tickTurret(v: Vehicle, dt: number) {
    v.turretTimer -= dt;
    if (v.turretTimer > 0) return;
    v.turretTimer = 0.13;
    const pos = v.position;
    const muzzle = pos.clone();
    muzzle.y += v.spec.size.y * 2 + 0.8;
    // nearest enemy in ANY direction with line of sight
    let best: Vehicle | null = null;
    let bestD = 48 * 48;
    for (const e of this.vehicles) {
      if (e === v || !e.alive) continue;
      const d = e.position.distanceToSquared(pos);
      if (d < bestD) { bestD = d; best = e; }
    }
    if (!best) return;
    const target = best.position;
    target.y += 0.4;
    const dir = _v1.copy(target).sub(muzzle).normalize();
    dir.x += (Math.random() - 0.5) * 0.04;
    dir.y += (Math.random() - 0.5) * 0.04;
    dir.z += (Math.random() - 0.5) * 0.04;
    dir.normalize();
    const dist = muzzle.distanceTo(target);
    const ray = new RAPIER.Ray(
      { x: muzzle.x, y: muzzle.y, z: muzzle.z },
      { x: dir.x, y: dir.y, z: dir.z },
    );
    const hit = this.world.castRay(ray, Math.min(dist + 2, 50), true, undefined, undefined, undefined, v.body);
    let end = muzzle.clone().addScaledVector(dir, 50);
    if (hit) {
      const toi = (hit as any).timeOfImpact ?? (hit as any).toi;
      end = muzzle.clone().addScaledVector(dir, toi);
      const victim = this.colliderToVehicle.get(hit.collider.handle);
      if (victim && victim.alive) {
        const dmg = this.drawSpecialBudget(v, victim, TURRET_SHOT);
        const killed = dmg > 0 && victim.takeDamage(dmg, v, this.time);
        this.effects.sparks(end, 3);
        if (v === this.player) this.hud.showHitmarker();
        if (victim === this.player) this.hud.showDamage(0.08);
        if (killed) this.onKill(v, victim);
      }
    }
    this.effects.tracer(muzzle, end, 0x66ddff);
    if (v === this.player || v.position.distanceTo(this.player.position) < 40) sfx.shoot();
  }

  private doSlam(v: Vehicle) {
    const at = v.position;
    if (this.netOpts?.role === 'host') {
      this.netEvents.push({ k: 'slam', x: +at.x.toFixed(1), y: +at.y.toFixed(1), z: +at.z.toFixed(1) });
    }
    this.effects.shockwave(at);
    sfx.explosion(THREE.MathUtils.clamp(1.5 - at.distanceTo(this.player.position) / 70, 0.3, 1.2));
    for (const e of this.vehicles) {
      if (e === v || !e.alive) continue;
      const d = e.position.distanceTo(at);
      if (d > 11) continue;
      const falloff = 1 - (d / 11) * 0.6;
      const dmg = this.drawSpecialBudget(v, e, SLAM_DAMAGE * falloff);
      const killed = dmg > 0 && e.takeDamage(dmg, v, this.time);
      _v1.copy(e.position).sub(at).normalize();
      _v1.y = 0.9; // fling them skyward
      _v1.normalize();
      const imp = 8.75 * e.body.mass() * falloff;
      e.body.applyImpulse({ x: _v1.x * imp, y: _v1.y * imp, z: _v1.z * imp }, true);
      if (e === this.player) this.hud.showDamage(0.4);
      if (killed) this.onKill(v, e);
    }
    for (const b of this.barrels) {
      if (!b.alive || b.fuse > 0) continue;
      const t = b.body.translation();
      if (at.distanceToSquared(_v1.set(t.x, t.y, t.z) as any) < 121) {
        b.fuse = 0.1 + Math.random() * 0.15;
        (b as any).igniter = v;
      }
    }
  }

  private launchBomb(v: Vehicle) {
    v.bombOut = true;
    const fwd = v.forward;
    const pos = v.position.addScaledVector(fwd, v.spec.size.z + 0.6);
    pos.y += 1.2;

    const fuseMat = new THREE.MeshStandardMaterial({
      color: 0xff3322, emissive: 0xff2200, emissiveIntensity: 1.5,
    });
    const mesh = new THREE.Group();
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0x1c1a22, roughness: 0.5, metalness: 0.5 }),
    );
    shell.castShadow = true;
    const fuse = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), fuseMat);
    fuse.position.y = 0.5;
    // world-space countdown ring — shrinks toward detonation
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.0, 28),
      new THREE.MeshBasicMaterial({ color: 0xfff3f5, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.35;
    mesh.add(shell, fuse, ring);
    mesh.position.copy(pos);
    this.scene.add(mesh);

    this.bombs.push({
      pos: pos.clone(),
      vel: fwd.clone().multiplyScalar(Math.max(16, v.forwardSpeed + 12)).add(new THREE.Vector3(0, 7.5, 0)),
      owner: v,
      landed: false,
      timer: 4,
      mesh,
      fuseMat,
      ring,
      dead: false,
    });
    sfx.missileLaunch();
  }

  private updateBombs(dt: number) {
    for (const b of this.bombs) {
      if (b.dead) continue;
      b.timer -= dt;
      if (b.timer <= 0) { this.detonateBomb(b); continue; }
      if (!b.landed) {
        b.vel.y -= 25 * dt;
        b.pos.addScaledVector(b.vel, dt);
        if (b.pos.y <= 0.5) {
          b.pos.y = 0.5;
          b.landed = true;
        }
        b.mesh.position.copy(b.pos);
      }
      // blink accelerates toward detonation; ring shrinks with the timer
      b.fuseMat.emissiveIntensity = 1.0 + Math.sin(this.time * (8 + (4 - b.timer) * 9)) * 0.9;
      b.ring.scale.setScalar(0.4 + (b.timer / 4) * 4.6);
      // bot owners auto-detonate when an enemy is close to the bomb
      if (b.owner.isBot) {
        for (const e of this.vehicles) {
          if (e === b.owner || !e.alive) continue;
          if (e.position.distanceToSquared(b.pos) < 42) { this.detonateBomb(b); break; }
        }
      }
    }
    this.bombs = this.bombs.filter((b) => !b.dead);
  }

  private detonateBomb(b: RemoteBomb) {
    if (b.dead) return;
    b.dead = true;
    b.owner.bombOut = false;
    this.scene.remove(b.mesh);
    this.explosionAt(b.pos, BOMB_DAMAGE, 8.5, b.owner, true);
  }

  private updateBarrels(dt: number) {
    for (const b of this.barrels) {
      if (!b.alive) {
        b.respawnTimer -= dt;
        if (b.respawnTimer <= 0) {
          // only respawn if no one is parked on the spot
          let clear = true;
          for (const v of this.vehicles) {
            if (v.alive && v.position.distanceToSquared(b.home) < 36) { clear = false; break; }
          }
          if (clear) {
            b.alive = true;
            b.mesh.visible = true;
            b.body.setTranslation({ x: b.home.x, y: b.home.y, z: b.home.z }, true);
            b.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
            b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
            b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
          }
        }
        continue;
      }
      // fuse burning (chain reaction delay)
      if (b.fuse > 0) {
        b.fuse -= dt;
        if (b.fuse <= 0) this.explodeBarrel(b);
        continue;
      }
      const t = b.body.translation();
      b.mesh.position.set(t.x, t.y, t.z);
      const r = b.body.rotation();
      b.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  private explodeBarrel(b: Barrel) {
    if (!b.alive) return;
    b.alive = false;
    b.respawnTimer = 25;
    b.mesh.visible = false;
    const t = b.body.translation();
    const at = new THREE.Vector3(t.x, t.y, t.z);
    b.body.setTranslation({ x: 0, y: -40 - Math.random() * 10, z: 0 }, false);
    b.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    b.body.sleep();
    const igniter: Vehicle | null = (b as any).igniter ?? null;
    (b as any).igniter = null;
    if (b.isPump) {
      b.respawnTimer = 60;   // pumps take a long time to "get repaired"
      this.explosionAt(at, BARREL_DAMAGE * 1.6, BARREL_RADIUS * 1.7, igniter, true);
      this.effects.trauma = Math.min(1, this.effects.trauma + 0.3);
    } else {
      this.explosionAt(at, BARREL_DAMAGE, BARREL_RADIUS, igniter, true);
    }
  }

  /** unified AoE: damages vehicles, shoves bodies, chains barrels, does FX */
  private explosionAt(at: THREE.Vector3, damage: number, radius: number, owner: Vehicle | null, big: boolean) {
    if (this.netOpts?.role === 'host') {
      this.netEvents.push({ k: 'boom', x: +at.x.toFixed(1), y: +at.y.toFixed(1), z: +at.z.toFixed(1), big: big ? 1 : 0 });
    }
    this.effects.explosion(at, big);
    sfx.explosion(THREE.MathUtils.clamp(1.4 - at.distanceTo(this.player.position) / 70, 0.15, 1));

    for (const v of this.vehicles) {
      if (!v.alive) continue;
      if (owner && v === owner) continue;
      const d = v.position.distanceTo(at);
      if (d > radius) continue;
      // direct hits (proximity-fused on the victim) take full damage —
      // keeps a landed missile above the special-damage cap
      const falloff = d < 2.6 ? 1 : 1 - (d / radius) * 0.65;
      const killed = v.takeDamage(damage * falloff, owner, this.time);
      _v1.copy(v.position).sub(at).normalize().add(new THREE.Vector3(0, 0.6, 0));
      const imp = 5 * v.body.mass() * falloff; // mass-normalized — same shove at any vehicle scale
      v.body.applyImpulse({ x: _v1.x * imp, y: _v1.y * imp, z: _v1.z * imp }, true);
      if (v === this.player) this.hud.showDamage(0.5);
      if (owner === this.player && v !== this.player) this.hud.showHitmarker();
      if (killed && owner) this.onKill(owner, v);
      else if (killed) this.onKill(v.lastDamager ?? v, v);
    }

    // chain nearby barrels with a short random fuse
    for (const b of this.barrels) {
      if (!b.alive || b.fuse > 0) continue;
      const t = b.body.translation();
      if (at.distanceToSquared(new THREE.Vector3(t.x, t.y, t.z) as any) < (radius + 1.5) ** 2) {
        b.fuse = 0.1 + Math.random() * 0.2;
        (b as any).igniter = owner;
      }
    }
    // explosions near the tower base chip the structure
    if (damage > 0 && Math.hypot(at.x, at.z) < 14) this.damageTower(damage, owner);
  }

  private handleCollisions(dt: number) {
    for (const [k, t] of this.ramCooldowns) {
      if (t - dt <= 0) this.ramCooldowns.delete(k);
      else this.ramCooldowns.set(k, t - dt);
    }
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const a = this.colliderToVehicle.get(h1);
      const b = this.colliderToVehicle.get(h2);
      // vehicle-vs-environment: sparks + thud + medium shake at speed
      if ((a || b) && !(a && b)) {
        const v = (a ?? b)!;
        const otherHandle = a ? h2 : h1;
        if (v.alive && !this.colliderToBarrel.has(otherHandle) && v.speed > 13) {
          const last = this.wallHitCooldowns.get(v) ?? -10;
          if (this.time - last > 0.4) {
            this.wallHitCooldowns.set(v, this.time);
            const at = v.position.addScaledVector(v.forward, v.spec.size.z * 0.9);
            at.y += 0.3;
            this.effects.sparks(at, 10, 0xffd9a0);
            if (v === this.player) {
              this.effects.trauma = Math.min(1, this.effects.trauma + 0.18);
              sfx.thud(0.7);
            } else if (v.position.distanceTo(this.player.position) < 35) {
              sfx.thud(0.35);
            }
          }
        }
        return;
      }
      if (!a || !b || !a.alive || !b.alive) return;
      const key = a.name < b.name ? a.name + b.name : b.name + a.name;
      if (this.ramCooldowns.has(key)) return;
      this.ramCooldowns.set(key, 0.5);

      const closing = _v1.copy(a.velocity).sub(b.velocity).length();
      const aDash = a.spec.specialId === 'dash' && a.specialActiveTime > 0;
      const bDash = b.spec.specialId === 'dash' && b.specialActiveTime > 0;
      if (closing < (aDash || bDash ? 6 : 10)) return;
      // plain rams are capped below every weapon tier
      const dmg = Math.min((closing - 9) * 1.3, RAM_CAP);
      const mid = _v2.copy(a.position).add(b.position).multiplyScalar(0.5);
      this.effects.sparks(mid, 12, 0xffe0a0);
      this.effects.trauma = Math.min(1, this.effects.trauma + 0.15);
      sfx.hit();
      const attacker = a.speed > b.speed ? a : b;
      // NITRO RAM: speed-scaled special damage drawn from the dash budget;
      // the dashing car shrugs off most of the impact
      let aTake = Math.max(0, dmg) * (attacker === b ? 1.25 : 0.75);
      let bTake = Math.max(0, dmg) * (attacker === a ? 1.25 : 0.75);
      if (aDash) {
        bTake = this.drawSpecialBudget(a, b, Math.min(DASH_BASE + closing * 0.5, SPECIAL_CAP));
        aTake *= 0.25;
        this.effects.explosion(mid, false);
      }
      if (bDash) {
        aTake = this.drawSpecialBudget(b, a, Math.min(DASH_BASE + closing * 0.5, SPECIAL_CAP));
        bTake *= 0.25;
        this.effects.explosion(mid, false);
      }
      const ka = a.takeDamage(aTake, b, this.time);
      const kb = b.takeDamage(bTake, a, this.time);
      if (a === this.player || b === this.player) this.hud.showDamage(0.3);
      if (ka) this.onKill(b, a);
      if (kb) this.onKill(a, b);
    });
  }

  /** bounty: the OUTRIGHT leader (score ≥5, lead ≥2) wears a gold mark —
   *  anyone who kills them gets a full special bar. Guests receive the index
   *  in the snapshot. */
  private updateBounty() {
    if (this.netOpts?.role === 'guest') return;
    const sorted = [...this.vehicles].sort((a, b) => b.score - a.score);
    const [first, second] = sorted;
    const newTarget =
      first && first.score >= 5 && first.score - (second?.score ?? 0) >= 2 && !first.eliminated
        ? first : null;
    if (newTarget !== this.bountyTarget) {
      this.bountyTarget = newTarget;
      if (newTarget) {
        this.hud.addKillFeed('◎', `BOUNTY on ${newTarget.name}`);
        if (newTarget === this.player) this.hud.toast('BOUNTY ON YOUR HEAD', '#ffd24a');
        if (this.netOpts?.role === 'host') {
          this.netEvents.push({ k: 'ann', vi: this.vehicles.indexOf(newTarget), t: 'BOUNTY ON YOUR HEAD', tier: 1, feed: `BOUNTY on ${newTarget.name}` });
        }
      }
    }
  }

  /** sudden death: triggers in the last 60s of time-attack, or after 4 min in
   *  the endless modes. Ring shrinks 200→45 over 90s around the town square. */
  private updateSuddenDeath() {
    if (this.netOpts?.role === 'guest') return;
    if (this.suddenDeathR === Infinity) {
      const trigger = this.mode === 'timed' ? this.timeLeft <= 60 : this.time >= 240;
      if (!trigger) return;
      this.suddenDeathR = 200;
      this.sdStartTime = this.time;
      this.sdNextTick = this.time;
      this.hud.toast('SUDDEN DEATH — GET TO THE SQUARE', '#ff4444');
      this.hud.addKillFeed('⚠', 'SUDDEN DEATH — the ring is closing');
      sfx.announce(3);
      if (this.netOpts?.role === 'host') {
        this.netEvents.push({ k: 'ann', vi: -1, t: 'SUDDEN DEATH — GET TO THE SQUARE', tier: 3 });
      }
      return;
    }
    this.suddenDeathR = Math.max(45, 200 - (this.time - this.sdStartTime) * 1.72);
    // burn tick every 0.5s for anyone outside the ring
    if (this.time >= this.sdNextTick) {
      this.sdNextTick = this.time + 0.5;
      for (const v of this.vehicles) {
        if (!v.alive) continue;
        const r = Math.hypot(v.position.x, v.position.z);
        if (r > this.suddenDeathR + 1) {
          if (v === this.player) this.hud.toast('OUTSIDE THE RING', '#ff4444');
          const killed = v.takeDamage(5, v.lastDamager, this.time);
          if (killed) this.onKill(v.lastDamager ?? v, v);
        }
      }
    }
  }

  /** structure damage on the clock tower (host authority) */
  damageTower(amount: number, source: Vehicle | null) {
    if (this.towerState !== 'standing' || this.netOpts?.role === 'guest') return;
    if (!this.arena.towerBody) return;
    this.towerHP -= amount;
    if (this.towerHP > 0) return;
    // topple away from whoever landed the killing blow (or a random way)
    this.towerState = 'warning';
    this.towerTimer = 2.0;
    const src = source?.position;
    if (src && (src.x !== 0 || src.z !== 0)) {
      this.towerDir.set(-src.x, 0, -src.z).normalize();
    } else {
      const a = Math.random() * Math.PI * 2;
      this.towerDir.set(Math.cos(a), 0, Math.sin(a));
    }
    this.hud.toast('THE CLOCK TOWER IS COMING DOWN', '#ff4444');
    this.hud.addKillFeed('⚠', 'the clock tower is falling!');
    sfx.announce(3);
    this.effects.trauma = 1;
    if (this.netOpts?.role === 'host') {
      this.netEvents.push({ k: 'twr', s: 'warn', dx: +this.towerDir.x.toFixed(3), dz: +this.towerDir.z.toFixed(3) });
    }
  }

  private updateTower(dt: number) {
    if (this.netOpts?.role === 'guest') return;
    if (this.towerState === 'warning') {
      this.towerTimer -= dt;
      this.effects.trauma = Math.min(1, this.effects.trauma + dt * 0.5);   // ground rumble
      if (this.towerTimer <= 0) {
        this.towerState = 'falling';
        this.towerFallT = 0;
        // the standing collider goes away the moment it starts to lean
        if (this.arena.towerBody) { this.world.removeRigidBody(this.arena.towerBody); this.arena.towerBody = undefined; }
        if (this.netOpts?.role === 'host') this.netEvents.push({ k: 'twr', s: 'fall' });
      }
    } else if (this.towerState === 'falling') {
      this.towerFallT += dt;
      if (this.towerFallT >= 1.3) {
        this.towerState = 'down';
        const d = this.towerDir;
        const at = new THREE.Vector3(d.x * 14, 1, d.z * 14);
        this.explosionAt(at, 0, 16, null, true);   // dust/shake only — crush is below
        this.effects.trauma = 1;
        // crush everything under the falling shaft (a 26m lane)
        for (const v of this.vehicles) {
          if (!v.alive) continue;
          const along = v.position.x * d.x + v.position.z * d.z;
          const perp = Math.abs(v.position.x * d.z - v.position.z * d.x);
          if (along > 3 && along < 27 && perp < 6.5) {
            if (v === this.player) this.hud.toast('CRUSHED', '#ff4444');
            const killed = v.takeDamage(70, null, this.time);
            if (killed) this.onKill(v.lastDamager ?? v, v);
          }
        }
        // fallen shaft becomes low rubble you can ram but not pass
        const yaw = Math.atan2(d.x, d.z);
        const body = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed()
            .setTranslation(d.x * 13.5, 1.0, d.z * 13.5)
            .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }),
        );
        this.world.createCollider(RAPIER.ColliderDesc.cuboid(3.2, 1.0, 12).setFriction(0.6), body);
      }
    }
  }

  private onKill(killer: Vehicle, victim: Vehicle) {
    if (!victim.alive) return; // already dead (double-hit in same tick)
    const pos = victim.position;
    this.effects.explosion(pos, true);
    sfx.explosion(THREE.MathUtils.clamp(1.5 - pos.distanceTo(this.player.position) / 70, 0.2, 1.2));
    if (killer !== victim) {
      killer.score++;
      // special energy is EARNED: +25% per kill; a 3-kill streak fills it
      killer.killStreak++;
      if (killer.killStreak >= 3 && killer.killStreak % 3 === 0) {
        killer.specialEnergy = 1;
        if (killer === this.player) this.hud.toast('KILL STREAK ×3 — SPECIAL FULL', '#e86bff');
      } else {
        killer.specialEnergy = Math.min(1, killer.specialEnergy + 0.25);
        if (killer === this.player) this.hud.toast('+25% SPECIAL', '#c94dff');
      }
      // announcer stingers
      const s = killer.killStreak;
      const ann: [string, number] | null =
        s === 2 ? ['DOUBLE KILL', 1] : s === 3 ? ['TRIPLE KILL', 2] :
        s === 4 ? ['RAMPAGE', 3] : s >= 6 ? ['UNSTOPPABLE', 3] : null;
      if (ann) {
        if (killer === this.player) { this.hud.toast(ann[0], '#ffd24a'); sfx.announce(ann[1]); }
        else this.hud.addKillFeed('⚡', `${killer.name} — ${ann[0]}`);
        if (this.netOpts?.role === 'host') {
          this.netEvents.push({ k: 'ann', vi: this.vehicles.indexOf(killer), t: ann[0], tier: ann[1] });
        }
      }
      // bounty claim: killing the marked leader = instant full special
      if (victim === this.bountyTarget) {
        killer.specialEnergy = 1;
        if (killer === this.player) { this.hud.toast('BOUNTY CLAIMED — SPECIAL FULL', '#ffd24a'); sfx.announce(2); }
        else this.hud.addKillFeed('◎', `${killer.name} claimed the bounty`);
        if (this.netOpts?.role === 'host') {
          this.netEvents.push({ k: 'ann', vi: this.vehicles.indexOf(killer), t: 'BOUNTY CLAIMED — SPECIAL FULL', tier: 2 });
        }
        this.bountyTarget = null;
      }
    }
    this.hud.addKillFeed(killer.name, victim.name);
    if (this.netOpts?.role === 'host') this.netEvents.push({ k: 'kill', a: killer.name, v: victim.name });
    victim.kill();
    if (this.mode === 'survival') {
      victim.lives--;
      if (victim.lives <= 0) {
        victim.eliminated = true;
        this.hud.addKillFeed('☠', `${victim.name} ELIMINATED`);
      }
    }
  }

  /** online host: a guest disconnected — their car keeps fighting as a bot */
  adoptBot(idx: number) {
    const v = this.vehicles[idx];
    if (v && !this.bots.some((b) => b.vehicle === v)) {
      v.isBot = true;
      this.bots.push(new BotController(v));
    }
  }

  /** Bulletproof spawn: every spawn point is a verified on-road coordinate
   *  (arena.ts places them on the ring highway). We score each by safety —
   *  far from enemies, and NOT in the path of an incoming missile — then route
   *  the player to the safest segment. Points inside the danger radius of an
   *  enemy or a homing missile are hard-invalidated. */
  private respawn(v: Vehicle) {
    const ENEMY_DANGER = 28;   // min clear distance to any living enemy
    const MISSILE_DANGER = 34; // min clear distance to any live missile heading here
    let best = this.arena.spawnPoints[0];
    let bestScore = -Infinity;
    for (const s of this.arena.spawnPoints) {
      let nearestEnemy = Infinity;
      let invalid = false;
      for (const e of this.vehicles) {
        if (e === v || !e.alive) continue;
        const d = e.position.distanceTo(s.pos);
        nearestEnemy = Math.min(nearestEnemy, d);
        if (d < ENEMY_DANGER) invalid = true;
      }
      // reject spawn points an active missile could reach — check both its
      // current proximity and whether it is flying toward this point
      for (const m of this.missiles) {
        if (m.dead) continue;
        const d = m.pos.distanceTo(s.pos);
        if (d < MISSILE_DANGER) {
          _v1.copy(s.pos).sub(m.pos).normalize();
          if (m.vel.lengthSq() < 0.01 || _v1.dot(m.vel.clone().normalize()) > 0.3) invalid = true;
        }
      }
      // score: prefer far-from-enemy valid points; invalid points sink far below
      const score = (invalid ? -1000 : 0) + Math.min(nearestEnemy, 120);
      if (score > bestScore) { bestScore = score; best = s; }
    }
    v.respawn(best.pos, best.yaw);
  }

  // ================= hot-wheels layer =================

  private updateBoostPads(dt: number) {
    const pads = this.arena.boostPads;
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      for (const v of this.vehicles) {
        if (!v.alive) continue;
        const pos = v.position;
        if (Math.abs(pos.x - pad.x) > pad.hx || Math.abs(pos.z - pad.z) > pad.hz || Math.abs(pos.y - 1 - pad.y) > 2.4) continue;
        const last = v.padCooldowns.get(i) ?? -10;
        if (this.time - last < PAD_COOLDOWN) continue;
        v.padCooldowns.set(i, this.time);
        // boost along current motion (or facing, from a standstill)
        const vel = v.velocity;
        const dir = vel.length() > 2 ? vel.setY(0).normalize() : (() => { const f = v.forward; f.y = 0; return f.normalize(); })();
        const newSpeed = Math.min(v.speed + PAD_BOOST, v.spec.topSpeed * PAD_MAX_SPEED_MULT);
        const gain = Math.max(0, newSpeed - v.speed);
        if (gain > 0) {
          const imp = gain * v.body.mass();
          v.body.applyImpulse({ x: dir.x * imp, y: 0, z: dir.z * imp }, true);
        }
        v.turboMeter = Math.min(v.spec.turboMax, v.turboMeter + 1.2);
        const back = dir.multiplyScalar(-1);
        const p = v.position.addScaledVector(back, v.spec.size.z);
        p.y += 0.3;
        for (let k = 0; k < 6; k++) this.effects.turboFlame(p, back);
        if (v === this.player) {
          sfx.missileLaunch();
          this.hud.toast('BOOST!', '#ffe44d');
        }
      }
    }
  }

  private onPedSplat(v: Vehicle, pos: THREE.Vector3) {
    this.effects.sparks(pos.clone().setY(pos.y + 0.8), 12, 0xbb1a1a);
    if (v === this.player) sfx.hit();
    // reward only at chase speed, rate-limited per vehicle (anti-farm)
    if (v.speed < PED_HEAL_MIN_SPEED) return;
    if (this.time - v.pedHealAt < PED_HEAL_COOLDOWN) return;
    if (v.health >= v.spec.maxHealth) return;
    v.pedHealAt = this.time;
    v.health = Math.min(v.spec.maxHealth, v.health + PED_HEAL);
    if (v === this.player) this.hud.toast('+4 ARMOR', '#ffffff');
  }

  private collectPickup(v: Vehicle, type: PickupType) {
    if (type === 'health') v.health = Math.min(v.spec.maxHealth, v.health + 40);
    else if (type === 'missiles') v.missiles = Math.min(3, v.missiles + 1);  // +1 each, rack of 3
    else if (type === 'turbo') v.turboMeter = v.spec.turboMax;
    else if (type === 'shield') v.shieldTime = 10;  // exactly 10s of full immunity
    else if (type === 'overdrive') v.overdriveTime = 8;
    else if (type === 'special') v.specialEnergy = Math.min(1, v.specialEnergy + 0.25);
    else v.minesAmmo = Math.min(6, v.minesAmmo + 2);
    if (this.netOpts?.role === 'host' && !v.isBot) {
      this.netEvents.push({ k: 'pick', vi: this.vehicles.indexOf(v), item: type });
    }
    // acquire burst in the item's hue (all vehicles — enemies read pickups too)
    this.effects.sparks(v.position.clone().setY(v.position.y + 0.6), 14, PICKUP_COLORS[type]);
    if (v === this.player) {
      sfx.pickup();
      const toasts: Record<PickupType, [string, string]> = {
        health: ['+40 ARMOR', '#ffffff'],
        missiles: ['+1 MISSILE', '#ff6a1a'],
        turbo: ['TURBO REFILLED', '#ffe44d'],
        shield: ['SHIELD ACTIVE', '#8fa5ff'],
        overdrive: ['OVERDRIVE!', '#ff44dd'],
        mines: ['+2 MINES', '#c9c9d4'],
        special: ['+25% SPECIAL', '#c94dff'],
      };
      this.hud.toast(...toasts[type]);
    }
  }

  /** per-render-frame updates (visuals, camera, HUD) */
  render(dt: number) {
    // gold bounty diamond over the marked leader
    if (!this.bountyMarker) {
      const gold = new THREE.MeshStandardMaterial({
        color: 0xffd24a, emissive: 0xcf9a1a, emissiveIntensity: 1.2, roughness: 0.3, metalness: 0.6,
      });
      const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.4, 0), gold);
      marker.visible = false;
      this.scene.add(marker);
      this.bountyMarker = marker;
    }
    const bt = this.bountyTarget;
    if (bt?.alive) {
      this.bountyMarker.visible = true;
      this.bountyMarker.position.set(bt.position.x, bt.position.y + 2.5 + Math.sin(this.time * 3) * 0.15, bt.position.z);
      this.bountyMarker.rotation.y += dt * 2.4;
    } else {
      this.bountyMarker.visible = false;
    }
    // sudden-death ring wall — translucent red curtain closing on the square
    if (!this.sdWall) {
      const wall = new THREE.Mesh(
        new THREE.CylinderGeometry(1, 1, 30, 64, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0xff3020, transparent: true, opacity: 0.22, side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        }),
      );
      wall.position.y = 15;
      wall.visible = false;
      this.scene.add(wall);
      this.sdWall = wall;
    }
    if (this.suddenDeathR !== Infinity) {
      this.sdWall.visible = true;
      this.sdWall.scale.set(this.suddenDeathR, 1, this.suddenDeathR);
      (this.sdWall.material as THREE.MeshBasicMaterial).opacity = 0.16 + Math.sin(this.time * 4) * 0.07;
    } else {
      this.sdWall.visible = false;
    }
    // clock tower topple animation (guests advance the fall timer here since
    // they never step the sim; the host advanced it in updateTower)
    if (this.towerState !== 'standing') {
      if (!this.towerPivot) {
        const mesh = this.scene.getObjectByName('ClockTower');
        if (mesh) {
          this.towerPivot = new THREE.Group();
          this.scene.add(this.towerPivot);
          this.towerPivot.attach(mesh);
        }
      }
      if (this.towerState === 'warning' && this.towerPivot) {
        this.towerPivot.position.x = (Math.random() - 0.5) * 0.12;   // shudder
        this.towerPivot.position.z = (Math.random() - 0.5) * 0.12;
      } else if (this.towerState !== 'warning' && this.towerPivot) {
        if (this.netOpts?.role === 'guest' && this.towerState === 'falling') {
          this.towerFallT = Math.min(1.3, this.towerFallT + dt);
        }
        const t = Math.min(1, this.towerFallT / 1.3);
        const axis = _v1.set(this.towerDir.z, 0, -this.towerDir.x);
        this.towerPivot.position.set(0, 0, 0);
        this.towerPivot.setRotationFromAxisAngle(axis, (Math.PI / 2) * t * t);
      }
    }
    for (const v of this.vehicles) {
      v.syncVisual();
      // post-spawn invulnerability: blink the car so it reads as protected
      if (v.mesh && v.alive) {
        v.mesh.visible = v.spawnProtection > 0 ? Math.floor(this.time * 9) % 2 === 0 : true;
      }
      if (v.shieldMesh) {
        v.shieldMesh.visible = v.alive && v.shieldTime > 0;
        if (v.shieldMesh.visible) {
          // steady faint lattice (no breathing blob), slow energy drift,
          // white-hot flare on blocked hits, rapid flicker in the final 2s
          v.shieldMesh.rotation.y += dt * 0.5;
          (v.shieldMesh.material as THREE.MeshBasicMaterial).opacity =
            0.15
            + v.shieldFlash * 2.4
            + (v.shieldTime < 2 ? 0.13 * Math.sin(this.time * 32) : 0);
        }
      }
      if (v.alive && v.input.turbo && v.turboMeter > 0 && v.input.throttle > 0) {
        const back = v.forward.multiplyScalar(-1);
        const p = v.position.addScaledVector(back, v.spec.size.z + 0.3);
        p.y += 0.3;
        // plasma exhaust: double flame + hot spark streaks
        this.effects.turboFlame(p, back);
        this.effects.turboFlame(p, back);
        if (Math.random() < 0.6) this.effects.sparks(p, 1, 0xfff0a0);
      }

      // drift: skid decals at the rear contact patches + tire smoke
      if (v.alive && v.drifting) {
        for (const contact of [v.rearContactL, v.rearContactR]) {
          if (Math.random() < 0.5) this.effects.smokeTrail(contact.clone().setY(contact.y + 0.15));
        }
        const lastAt = this.lastSkidAt.get(v);
        if (!lastAt || lastAt.distanceToSquared(v.position) > 0.55) {
          this.lastSkidAt.set(v, v.position.clone());
          const yaw = Math.atan2(-v.forward.x, -v.forward.z);
          for (const contact of [v.rearContactL, v.rearContactR]) {
            const s = this.skids[this.skidCursor];
            this.skidCursor = (this.skidCursor + 1) % this.skids.length;
            s.position.copy(contact).setY(contact.y + 0.03);
            s.rotation.z = yaw;
            s.visible = true;
          }
        }
      }

      // ground-projected contact shadow: fades out + expands with altitude
      const blob = this.shadowBlobs.get(v);
      if (blob) {
        blob.visible = v.alive;
        if (v.alive) {
          const pos = v.position;
          const ray = new RAPIER.Ray({ x: pos.x, y: pos.y, z: pos.z }, { x: 0, y: -1, z: 0 });
          const hit = this.world.castRay(ray, 30, true, undefined, undefined, undefined, v.body);
          if (hit) {
            const toi = (hit as any).timeOfImpact ?? (hit as any).toi;
            const alt = Math.max(0, toi - 1.0);   // height above resting ride
            blob.position.set(pos.x, pos.y - toi + 0.06, pos.z);
            const spread = 1 + alt * 0.10;
            blob.scale.set(spread, spread, spread);
            (blob.material as THREE.MeshBasicMaterial).opacity = 0.62 / (1 + alt * 0.6);
          } else {
            blob.visible = false;
          }
        }
      }
    }
    // mine arming blink
    for (const m of this.mines) {
      if (m.dead) continue;
      m.glowMat.emissiveIntensity = m.armTime > 0 ? 0.4 : 1.0 + Math.sin(this.time * 10) * 0.8;
    }
    // nitro audio is stateful: ignition vroom on engage, sustained whoosh held
    // exactly as long as boost is active, fast cut on release/empty meter
    const turboOn = this.player.alive && this.player.input.turbo && this.player.turboMeter > 0 && this.player.input.throttle > 0;
    if (turboOn && !this.prevTurboOn) sfx.revBlip();
    if (!turboOn && this.prevTurboOn) sfx.revStop();
    sfx.nitro(turboOn && this.state === 'playing' && !this.paused, THREE.MathUtils.clamp(this.player.speed / 36, 0, 1));
    this.prevTurboOn = turboOn;

    // lock-acquired sound cue on the rising edge
    const lockedNow = !!this.player.lockTarget && this.player.alive;
    if (lockedNow && !this.wasLocked) sfx.lockOn();
    this.wasLocked = lockedNow;

    // incoming-missile alarm: slow beep → frantic as it closes in
    if (this.player.alive && this.state === 'playing' && !this.paused) {
      let nearest = Infinity;
      for (const m of this.missiles) {
        if (!m.dead && m.target === this.player) {
          nearest = Math.min(nearest, m.pos.distanceTo(this.player.position));
        }
      }
      if (nearest < Infinity) {
        this.missileAlarmT -= dt;
        if (this.missileAlarmT <= 0) {
          const urgent = nearest < 22;
          sfx.warnBeep(urgent);
          this.missileAlarmT = THREE.MathUtils.clamp(nearest / 75, 0.09, 0.65);
        }
      } else {
        this.missileAlarmT = 0;
      }
    }

    // panic heartbeat — quickens as armor drops
    const hpRatio = this.player.health / this.player.spec.maxHealth;
    if (this.player.alive && hpRatio < 0.3 && this.state === 'playing' && !this.paused) {
      this.heartbeatT -= dt;
      if (this.heartbeatT <= 0) {
        sfx.heartbeat();
        this.heartbeatT = 0.45 + hpRatio * 2.2;
      }
    }

    // flush aggregated damage numbers as world-anchored popups
    for (const [victim, e] of this.pendingDmg) {
      e.t += dt;
      if (e.t < 0.25) continue;
      this.pendingDmg.delete(victim);
      _v1.copy(victim.position).setY(victim.position.y + 1.6).project(this.camera);
      if (_v1.z < 1 && Math.abs(_v1.x) < 1.1 && Math.abs(_v1.y) < 1.1) {
        const ratio = victim.alive ? victim.health / victim.spec.maxHealth : 0;
        this.hud.popDamage(
          (_v1.x + 1) * 50, (1 - _v1.y) * 50,
          `-${Math.max(1, Math.round(e.sum))}`,
          ratio < 0.3 ? '#ff5a4a' : '#ffd25e',
        );
      }
    }

    // over-vehicle enemy health bars: targeted, locking, or recently damaged
    for (const [v, entry] of this.hpSprites) {
      const relevant = v !== this.player && v.alive && (
        v === this.player.lockTarget ||
        (v === this.player.lockCandidate && this.player.lockProgress > 0) ||
        this.time - v.lastDamageTime < 3
      );
      const dist = relevant ? v.position.distanceTo(this.player.position) : 999;
      entry.sprite.visible = relevant && dist < 90 && this.player.alive;
      if (entry.sprite.visible) {
        entry.sprite.position.copy(v.position).setY(v.position.y + v.spec.size.y * 2 + 1.3);
        const hp = Math.round(v.health);
        if (hp !== entry.lastHp) {
          entry.lastHp = hp;
          this.drawHpSprite(entry, v.health / v.spec.maxHealth);
        }
      }
    }

    this.effects.update(dt);
    this.updateCamera(dt);
    this.hud.update(dt, this.player, this.vehicles, this);

    if (this.player.alive && this.state === 'playing' && !this.paused) {
      sfx.engine(
        Math.min(1, this.player.speed / this.player.spec.topSpeed),
        this.player.input.turbo && this.player.turboMeter > 0,
      );
    } else {
      sfx.engineOff();
    }
  }

  private updateCamera(dt: number) {
    const p = this.player;
    const pos = p.position;
    const fwd = p.forward;
    fwd.y = 0;
    if (fwd.lengthSq() < 0.001) fwd.set(0, 0, -1);
    fwd.normalize();

    // smaller cars: camera pulls in; distance stretches slightly with speed so
    // the car "pulls away" under acceleration (speed illusion); turbo pulls
    // the camera back further and blooms FOV +15° (smoothly eased both ways)
    const turboNow = p.alive && p.input.turbo && p.turboMeter > 0 && p.input.throttle > 0;
    this.turboLerp += ((turboNow ? 1 : 0) - this.turboLerp) * (1 - Math.exp(-5 * dt));
    const speedN = THREE.MathUtils.clamp(p.speed / 36, 0, 1);
    const dist = 7.8 + speedN * 1.6 + this.turboLerp * 1.7;
    const height = 3.4 + speedN * 0.4 + this.turboLerp * 0.3;
    _v1.copy(pos).addScaledVector(fwd, -dist).setY(pos.y + height);

    if (!this.camInit) {
      this.camPos.copy(_v1);
      this.camInit = true;
    }
    const k = p.alive ? 1 - Math.exp(-7 * dt) : 1 - Math.exp(-1.2 * dt);
    this.camPos.lerp(_v1, k);
    if (this.camPos.y < 1.2) this.camPos.y = 1.2;
    this.camera.position.copy(this.camPos);

    // occlusion: pull the camera in front of any wall between it and the car
    _v3.copy(pos).setY(pos.y + 1.2);
    const toCam = _v1.copy(this.camPos).sub(_v3);
    const camDist = toCam.length();
    if (camDist > 0.5) {
      toCam.normalize();
      const ray = new RAPIER.Ray(
        { x: _v3.x, y: _v3.y, z: _v3.z },
        { x: toCam.x, y: toCam.y, z: toCam.z },
      );
      const hit = this.world.castRay(ray, camDist, true, undefined, undefined, undefined, p.body);
      if (hit) {
        const toi = (hit as any).timeOfImpact ?? (hit as any).toi;
        if (toi > 0.01 && !this.colliderToVehicle.has(hit.collider.handle) && !this.colliderToBarrel.has(hit.collider.handle)) {
          this.camera.position.copy(_v3).addScaledVector(toCam, Math.max(0.5, toi - 0.4));
        }
      }
    }

    const tr = this.effects.trauma * this.effects.trauma;
    if (tr > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * tr * 0.9;
      this.camera.position.y += (Math.random() - 0.5) * tr * 0.9;
      this.camera.position.z += (Math.random() - 0.5) * tr * 0.9;
    }

    _v2.copy(pos).addScaledVector(fwd, 6.5).setY(pos.y + 1.0);
    this.camera.lookAt(_v2);

    // dynamic FOV: blooms quadratically with speed (strongest speed cue),
    // turbo adds a full +15° on top
    const targetFov = 72 + speedN * speedN * 11 + this.turboLerp * 15;
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-6 * dt));
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
  }

  dispose(renderer: THREE.WebGLRenderer) {
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.Line) {
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m?.dispose();
      }
    });
    this.world.free();
    renderer.renderLists.dispose();
  }
}
