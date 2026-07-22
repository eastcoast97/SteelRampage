import * as THREE from 'three';
import type { Game } from '../game/game';
import { sfx } from '../audio/sfx';
import { PICKUP_COLORS, PICKUP_TYPE_ORDER } from '../game/pickups';

/** Host-authoritative netcode: the host's browser runs the real sim; guests
 *  send inputs and render interpolated snapshots. A tiny relay server
 *  (server/server.js) forwards messages by room code. */

// Relay URL resolution:
//  • VITE_RELAY_URL env override wins (for a separately-hosted relay).
//  • Production (page served over https by the single-service server) → same
//    origin over wss, so page + socket share a host (no mixed-content/CORS).
//  • Local dev (vite http on :5173) → the relay on :8787 on the same machine.
export const NET_URL =
  (import.meta as any).env?.VITE_RELAY_URL ||
  (location.protocol === 'https:'
    ? `wss://${location.host}`
    : `ws://${location.hostname}:8787`);
export const SNAPSHOT_HZ = 20;
const INTERP_DELAY_MS = 110;

// ---------------------------------------------------------------- client

export class NetClient {
  ws: WebSocket | null = null;
  id = 0;
  code = '';
  isHost = false;
  private handlers = new Map<string, (m: any) => void>();

  on(type: string, fn: (m: any) => void) { this.handlers.set(type, fn); }

  connect(url = NET_URL): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('Relay server unreachable — is it running? (npm run server)'));
      this.ws.onmessage = (e) => {
        let m: any;
        try { m = JSON.parse(e.data); } catch { return; }
        this.handlers.get(m.t)?.(m);
      };
      this.ws.onclose = () => this.handlers.get('_closed')?.({});
    });
  }

  send(obj: any) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

// ---------------------------------------------------------------- snapshots

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** host: pack the entire visible game state (~2-3 KB as JSON) */
export function serializeSnapshot(g: Game): any {
  const veh = g.vehicles.map((v) => {
    const t = v.body.translation();
    const q = v.body.rotation();
    const lv = v.body.linvel();
    const turboOn = v.alive && v.input.turbo && v.turboMeter > 0 && v.input.throttle > 0;
    const flags =
      (v.alive ? 1 : 0) | (v.shieldTime > 0 ? 2 : 0) | (v.input.fireMG && v.alive ? 4 : 0) |
      (turboOn ? 8 : 0) | (v.eliminated ? 16 : 0) | (v.overdriveTime > 0 ? 32 : 0) | (v.drifting ? 64 : 0);
    return [
      r2(t.x), r2(t.y), r2(t.z), r2(q.x), r2(q.y), r2(q.z), r2(q.w),
      r1(lv.x), r1(lv.y), r1(lv.z),
      Math.round(v.health), v.score, flags,
      Math.round(v.specialEnergy * 100), r1(v.shieldTime), Math.round(v.lockProgress * 100),
      v.lockTarget ? g.vehicles.indexOf(v.lockTarget) : -1,
      v.missiles, v.minesAmmo, r1(v.turboMeter), v.lives,
      r1(v.specialActiveTime), v.killStreak, r1(v.specialWindow),
    ];
  });
  const mis = g.missiles.filter((m) => !m.dead).map((m) => [r1(m.pos.x), r1(m.pos.y), r1(m.pos.z), r1(m.vel.x), r1(m.vel.y), r1(m.vel.z)]);
  const mns = g.mines.filter((m) => !m.dead).map((m) => [r1(m.pos.x), r1(m.pos.y), r1(m.pos.z), m.armTime <= 0 ? 1 : 0]);
  const bmb = g.bombs.filter((b) => !b.dead).map((b) => [r1(b.pos.x), r1(b.pos.y), r1(b.pos.z), r1(b.timer)]);
  const brl = g.barrels.map((b) => {
    if (!b.alive) return 0;
    const t = b.body.translation();
    const q = b.body.rotation();
    return [r1(t.x), r1(t.y), r1(t.z), r2(q.x), r2(q.y), r2(q.z), r2(q.w)];
  });
  const pk = (g.pickups as any)['pickups'].map((p: any) =>
    [p.active ? 1 : 0, r1(p.pos.x), r1(p.pos.y), r1(p.pos.z), PICKUP_TYPE_ORDER.indexOf(p.type)]);
  const ped: number[] = [];
  for (const p of (g.peds as any)['peds']) ped.push(r1(p.pos.x), r1(p.pos.z), p.state === 'dead' ? 0 : 1);
  const ev = g.netEvents;
  g.netEvents = [];
  return {
    st: [
      g.state === 'over' ? 1 : 0, r1(g.timeLeft),
      g.bountyTarget ? g.vehicles.indexOf(g.bountyTarget) : -1,
      g.suddenDeathR === Infinity ? -1 : Math.round(g.suddenDeathR),
    ],
    veh, mis, mns, bmb, brl, pk, ped, ev,
  };
}

// ---------------------------------------------------------------- guest sync

function buildProxyMissile(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13, 0.13, 0.85, 8),
    new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.3, metalness: 0.65 }),
  );
  body.rotation.x = Math.PI / 2;
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.13, 0.36, 8),
    new THREE.MeshStandardMaterial({ color: 0xff6a1a, emissive: 0xff4400, emissiveIntensity: 0.7 }),
  );
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -0.6;
  const plume = new THREE.Mesh(
    new THREE.ConeGeometry(0.09, 0.42, 8),
    new THREE.MeshBasicMaterial({ color: 0xff8830, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  plume.rotation.x = -Math.PI / 2;
  plume.position.z = 0.66;
  g.add(body, nose, plume);
  return g;
}

function buildProxyMine(): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.5, 0.22, 10),
    new THREE.MeshStandardMaterial({ color: 0x2a2730, roughness: 0.6, metalness: 0.4 }),
  );
  const bump = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xff3322, emissive: 0xff2200, emissiveIntensity: 1.2 }),
  );
  bump.position.y = 0.16;
  g.add(base, bump);
  return g;
}

function buildProxyBomb(): THREE.Group {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0x1c1a22, roughness: 0.5, metalness: 0.5 }),
  );
  const fuse = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xff3322, emissive: 0xff2200, emissiveIntensity: 1.5 }),
  );
  fuse.position.y = 0.5;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.85, 1.0, 28),
    new THREE.MeshBasicMaterial({ color: 0xfff3f5, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -0.35;
  g.add(shell, fuse, ring);
  return g;
}

class ProxyPool {
  items: THREE.Group[] = [];
  constructor(private scene: THREE.Scene, private builder: () => THREE.Group, count: number) {
    for (let i = 0; i < count; i++) {
      const m = builder();
      m.visible = false;
      scene.add(m);
      this.items.push(m);
    }
  }
  show(n: number): THREE.Group[] {
    this.items.forEach((m, i) => (m.visible = i < n));
    return this.items;
  }
}

const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qo = new THREE.Quaternion();

/** applies host snapshots to a guest's render-only Game */
export class GuestSync {
  private buf: { rt: number; s: any }[] = [];
  private missilePool: ProxyPool;
  private minePool: ProxyPool;
  private bombPool: ProxyPool;
  gameOver: { order: number[]; scores: number[]; sub: string } | null = null;

  constructor(private game: Game, private myIdx: number) {
    this.missilePool = new ProxyPool(game.scene, buildProxyMissile, 14);
    this.minePool = new ProxyPool(game.scene, buildProxyMine, 12);
    this.bombPool = new ProxyPool(game.scene, buildProxyBomb, 4);
  }

  onSnapshot(s: any) {
    this.buf.push({ rt: performance.now(), s });
    if (this.buf.length > 10) this.buf.shift();
    this.applyEvents(s.ev ?? []);
    this.applyDiscrete(s);
  }

  /** events fire once, on arrival */
  private applyEvents(evts: any[]) {
    const g = this.game;
    const me = g.vehicles[this.myIdx];
    for (const e of evts) {
      if (e.k === 'boom') {
        const at = new THREE.Vector3(e.x, e.y, e.z);
        g.effects.explosion(at, !!e.big);
        sfx.explosion(Math.max(0.15, Math.min(1, 1.4 - at.distanceTo(me.position) / 70)));
      } else if (e.k === 'slam') {
        g.effects.shockwave(new THREE.Vector3(e.x, e.y, e.z));
      } else if (e.k === 'kill') {
        g.hud.addKillFeed(e.a, e.v);
      } else if (e.k === 'ann') {
        // announcer: toast + stinger for the subject (vi === -1 → everyone)
        if (e.vi === this.myIdx || e.vi === -1) { g.hud.toast(e.t, e.vi === -1 ? '#ff4444' : '#ffd24a'); sfx.announce(e.tier ?? 1); }
        else g.hud.addKillFeed('⚡', e.feed ?? `${g.vehicles[e.vi]?.name ?? '?'} — ${e.t}`);
      } else if (e.k === 'twr') {
        if (e.s === 'warn') {
          (g as any).towerState = 'warning';
          if (typeof e.dx === 'number') (g as any).towerDir.set(e.dx, 0, e.dz);
          g.hud.toast('THE CLOCK TOWER IS COMING DOWN', '#ff4444');
          sfx.announce(3);
          g.effects.trauma = 1;
        } else if (e.s === 'fall') {
          (g as any).towerState = 'falling';
          (g as any).towerFallT = 0;
        }
      } else if (e.k === 'pick' && e.vi === this.myIdx) {
        sfx.pickup();
        const toasts: Record<string, [string, string]> = {
          health: ['+40 ARMOR', '#ffffff'], missiles: ['+1 MISSILE', '#ff6a1a'],
          turbo: ['TURBO REFILLED', '#ffe44d'], shield: ['SHIELD ACTIVE', '#8fa5ff'],
          overdrive: ['OVERDRIVE!', '#ff44dd'], mines: ['+2 MINES', '#c9c9d4'],
        };
        const t = toasts[e.item];
        if (t) g.hud.toast(...t);
      } else if (e.k === 'dmg' && e.ai === this.myIdx) {
        const victim = g.vehicles[e.vi];
        if (victim) {
          const p = victim.position.clone().setY(victim.position.y + 1.6).project(g.camera);
          if (p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1) {
            const ratio = victim.health / victim.spec.maxHealth;
            g.hud.popDamage((p.x + 1) * 50, (1 - p.y) * 50, `-${Math.max(1, e.amt)}`, ratio < 0.3 ? '#ff5a4a' : '#ffd25e');
          }
          if (e.amt > 0) g.hud.showHitmarker();
        }
      } else if (e.k === 'over') {
        this.gameOver = e;
      }
    }
  }

  /** non-interpolated state: HUD fields, entity pools, pickups, barrels, peds */
  private applyDiscrete(s: any) {
    const g = this.game;
    // vehicles: gameplay fields (transforms are interpolated separately)
    s.veh.forEach((a: number[], i: number) => {
      const v = g.vehicles[i];
      if (!v) return;
      const flags = a[12];
      const wasAlive = v.alive;
      v.alive = !!(flags & 1);
      if (v.mesh) v.mesh.visible = v.alive;
      if (!v.alive && wasAlive && v === g.vehicles[this.myIdx]) v.respawnTimer = 3;
      if (!v.alive) v.respawnTimer = Math.max(0, v.respawnTimer - 1 / SNAPSHOT_HZ);
      v.health = a[10];
      v.score = a[11];
      v.shieldTime = a[14];
      v.specialEnergy = a[13] / 100;
      v.lockProgress = a[15] / 100;
      v.lockTarget = a[16] >= 0 ? g.vehicles[a[16]] ?? null : null;
      v.lockCandidate = v.lockTarget ?? (v.lockProgress > 0 ? v.lockCandidate : null);
      v.missiles = a[17];
      v.minesAmmo = a[18];
      v.turboMeter = a[19];
      v.lives = a[20];
      v.specialActiveTime = a[21];
      v.killStreak = a[22] ?? 0;
      v.specialWindow = a[23] ?? 0;
      v.eliminated = !!(flags & 16);
      v.overdriveTime = flags & 32 ? 1 : 0;
      v.drifting = !!(flags & 64);
      v.input.turbo = !!(flags & 8);
      v.input.throttle = flags & 8 ? 1 : v.input.throttle;
      v.input.fireMG = !!(flags & 4);
    });
    // projectiles / mines / bombs via pools
    const mis = this.missilePool.show(s.mis.length);
    s.mis.forEach((m: number[], i: number) => {
      mis[i].position.set(m[0], m[1], m[2]);
      mis[i].lookAt(m[0] + m[3], m[1] + m[4], m[2] + m[5]);
      if (Math.random() < 0.5) this.game.effects.smokeTrail(mis[i].position);
    });
    const mns = this.minePool.show(s.mns.length);
    s.mns.forEach((m: number[], i: number) => mns[i].position.set(m[0], m[1], m[2]));
    const bmb = this.bombPool.show(s.bmb.length);
    s.bmb.forEach((b: number[], i: number) => {
      bmb[i].position.set(b[0], b[1], b[2]);
      const ring = bmb[i].children[2];
      ring.scale.setScalar(0.4 + (b[3] / 4) * 4.6);
    });
    // barrels
    s.brl.forEach((b: any, i: number) => {
      const barrel = g.barrels[i];
      if (!barrel) return;
      barrel.alive = b !== 0;
      barrel.mesh.visible = barrel.alive;
      if (b !== 0) {
        barrel.mesh.position.set(b[0], b[1], b[2]);
        barrel.mesh.quaternion.set(b[3], b[4], b[5], b[6]);
      }
    });
    // bounty target + sudden-death radius from snapshot header
    (g as any).bountyTarget = s.st[2] >= 0 ? g.vehicles[s.st[2]] ?? null : null;
    (g as any).suddenDeathR = (s.st[3] ?? -1) > 0 ? s.st[3] : Infinity;
    // pickups (roaming ones move; types shuffle — both come with the flag)
    (g.pickups as any)['pickups'].forEach((p: any, i: number) => {
      const a = s.pk[i];
      if (!a) return;
      if (typeof a[4] === 'number' && a[4] >= 0) (g.pickups as any).setTypeByIndex(i, a[4]);
      p.active = a[0] === 1;
      p.pos.set(a[1], a[2], a[3]);
      p.mesh.position.set(a[1], a[2], a[3]);
      p.mesh.visible = p.active;
      p.ring.position.set(a[1], a[2] - 0.75, a[3]);
      p.ringMat.opacity = p.active ? 0.4 : 0.12;
    });
    // pedestrians
    const peds = (g.peds as any)['peds'];
    for (let i = 0; i < peds.length; i++) {
      const x = s.ped[i * 3], z = s.ped[i * 3 + 1], vis = s.ped[i * 3 + 2];
      peds[i].mesh.visible = vis === 1;
      peds[i].pos.set(x, 0, z);
      peds[i].mesh.position.set(x, 0, z);
    }
    // match state
    g.timeLeft = s.st[1];
  }

  /** per-frame: interpolate vehicle transforms ~110ms behind real time */
  update() {
    const g = this.game;
    if (this.buf.length < 2) return;
    const target = performance.now() - INTERP_DELAY_MS;
    let a = this.buf[0], b = this.buf[1];
    for (let i = this.buf.length - 1; i >= 1; i--) {
      if (this.buf[i - 1].rt <= target) { a = this.buf[i - 1]; b = this.buf[i]; break; }
    }
    const span = Math.max(1, b.rt - a.rt);
    const alpha = Math.max(0, Math.min(1, (target - a.rt) / span));
    g.vehicles.forEach((v, i) => {
      const va = a.s.veh[i], vb = b.s.veh[i];
      if (!va || !vb || !v.alive) return;
      const x = va[0] + (vb[0] - va[0]) * alpha;
      const y = va[1] + (vb[1] - va[1]) * alpha;
      const z = va[2] + (vb[2] - va[2]) * alpha;
      v.body.setTranslation({ x, y, z }, false);
      _q1.set(va[3], va[4], va[5], va[6]);
      _q2.set(vb[3], vb[4], vb[5], vb[6]);
      _qo.slerpQuaternions(_q1, _q2, alpha);
      v.body.setRotation({ x: _qo.x, y: _qo.y, z: _qo.z, w: _qo.w }, false);
      v.body.setLinvel({ x: vb[7], y: vb[8], z: vb[9] }, false);
      // spin wheels from actual speed; fake rear contacts for drift smoke
      const spd = Math.hypot(vb[7], vb[8], vb[9]);
      v.wheelSpin += (spd / 0.26) * (1 / 60);
      if (v.drifting) {
        const fwd = v.forward;
        v.rearContactL.set(x - fwd.x * v.spec.size.z * 0.72 - fwd.z * 0.5, y - 0.5, z - fwd.z * v.spec.size.z * 0.72 + fwd.x * 0.5);
        v.rearContactR.set(x - fwd.x * v.spec.size.z * 0.72 + fwd.z * 0.5, y - 0.5, z - fwd.z * v.spec.size.z * 0.72 - fwd.x * 0.5);
      }
    });
    // approximate MG audio/tracers for firing vehicles
    for (const v of g.vehicles) {
      if (v.alive && v.input.fireMG && Math.random() < 0.25) {
        const from = v.position.addScaledVector(v.forward, v.spec.size.z + 0.4);
        from.y += 0.4;
        const to = v.lockTarget
          ? v.lockTarget.position.clone()
          : from.clone().addScaledVector(v.forward, 40);
        g.effects.tracer(from, to, 0xffd070);
        if (v.position.distanceTo(g.vehicles[this.myIdx].position) < 40 && Math.random() < 0.5) sfx.shoot();
      }
    }
  }
}
