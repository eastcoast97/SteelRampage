import * as THREE from 'three';
import { SpriteBatch } from './spriteBatch';
import {
  getAdditiveAtlas, getAlphaAtlas,
  CELL_FIRE_0, CELL_FIRE_N, CELL_GLOW, CELL_SPARK, CELL_RING, CELL_EMBER,
  CELL_SMOKE_0, CELL_SMOKE_N,
} from './particleAtlas';

const MAX_ADDITIVE = 900;
const MAX_ALPHA = 500;
const MAX_TRACERS = 28;

/** 0 = additive atlas (fire/sparks/glow), 1 = alpha atlas (smoke) */
type Layer = 0 | 1;

interface Particle {
  alive: boolean;
  layer: Layer;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  sizeFrom: number;
  sizeTo: number;
  rot: number;
  rotVel: number;
  /** true for sparks: the quad points along its own velocity instead of spinning */
  alignToVelocity: boolean;
  colorFrom: THREE.Color;
  colorTo: THREE.Color;
  gravity: number;
  drag: number;
  /** first atlas cell, and how many to play through over the particle's life */
  cell: number;
  cells: number;
  opacity: number;
  /** 0 = fade out linearly, 1 = fade in then out (smoke blooms before it thins) */
  fadeIn: number;
  /** lie in the ground plane rather than facing the camera (blast rings) */
  flat: boolean;
}

function makeParticle(): Particle {
  return {
    alive: false, layer: 0,
    pos: new THREE.Vector3(), vel: new THREE.Vector3(),
    life: 0, maxLife: 1, sizeFrom: 1, sizeTo: 1,
    rot: 0, rotVel: 0, alignToVelocity: false,
    colorFrom: new THREE.Color(), colorTo: new THREE.Color(),
    gravity: 0, drag: 0, cell: 0, cells: 1, opacity: 1, fadeIn: 0, flat: false,
  };
}

interface EmitOpts {
  layer?: Layer;
  life: number;
  sizeFrom: number;
  sizeTo: number;
  from: number;
  to: number;
  cell?: number;
  cells?: number;
  gravity?: number;
  drag?: number;
  spin?: number;
  alignToVelocity?: boolean;
  opacity?: number;
  fadeIn?: number;
  flat?: boolean;
}

export class Effects {
  private particles: Particle[] = [];
  private cursor = 0;
  private additive: SpriteBatch;
  private alpha: SpriteBatch;

  private tracers: { line: THREE.Line; mat: THREE.LineBasicMaterial; life: number }[] = [];
  private flashLight: THREE.PointLight;
  private flashTimer = 0;
  /** continuous emitter lights (flamethrower, turbo) driven per render frame —
   *  explosions get the one-shot flashLight instead */
  private glows = new Map<string, THREE.PointLight>();
  private glowScene: THREE.Scene | null = null;

  /** camera shake 0..1 */
  trauma = 0;

  private scratchColor = new THREE.Color();
  private scratchVec = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < MAX_ADDITIVE + MAX_ALPHA; i++) this.particles.push(makeParticle());

    this.additive = new SpriteBatch(MAX_ADDITIVE, getAdditiveAtlas(), true);
    this.alpha = new SpriteBatch(MAX_ALPHA, getAlphaAtlas(), false);
    scene.add(this.alpha.mesh, this.additive.mesh);

    for (let i = 0; i < MAX_TRACERS; i++) {
      const mat = new THREE.LineBasicMaterial({
        color: 0xffd070,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(g, mat);
      line.visible = false;
      line.frustumCulled = false;
      scene.add(line);
      this.tracers.push({ line, mat, life: 0 });
    }

    this.flashLight = new THREE.PointLight(0xffaa44, 0, 40, 1.8);
    scene.add(this.flashLight);
    this.glowScene = scene;
  }

  private emit(pos: THREE.Vector3, vel: THREE.Vector3, o: EmitOpts) {
    const p = this.particles[this.cursor];
    this.cursor = (this.cursor + 1) % this.particles.length;
    p.alive = true;
    p.layer = o.layer ?? 0;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.life = o.life;
    p.maxLife = o.life;
    p.sizeFrom = o.sizeFrom;
    p.sizeTo = o.sizeTo;
    p.colorFrom.setHex(o.from);
    p.colorTo.setHex(o.to);
    p.gravity = o.gravity ?? 0;
    p.drag = o.drag ?? 0;
    p.cell = o.cell ?? CELL_GLOW;
    p.cells = o.cells ?? 1;
    p.opacity = o.opacity ?? 1;
    p.fadeIn = o.fadeIn ?? 0;
    p.flat = o.flat ?? false;
    p.alignToVelocity = o.alignToVelocity ?? false;
    p.rot = o.alignToVelocity ? 0 : Math.random() * Math.PI * 2;
    p.rotVel = o.spin ?? 0;
  }

  explosion(pos: THREE.Vector3, big = false) {
    const power = big ? 17 : 11;
    const scale = big ? 1.45 : 1;

    // fireball: a few big slow flipbook puffs make the core, a ring of faster
    // smaller ones throws it outward
    for (let i = 0; i < (big ? 8 : 6); i++) {
      this.emit(
        this.scratchVec.copy(pos).addScaledVector(randomDir(), 0.5 * scale),
        randomDir().multiplyScalar(2.5 * scale),
        { life: 0.5 + Math.random() * 0.25, sizeFrom: 1.6 * scale, sizeTo: 3.8 * scale,
          from: 0xffffff, to: 0xff7a22, cell: CELL_FIRE_0, cells: CELL_FIRE_N,
          gravity: -3.5, drag: 2.6, spin: (Math.random() - 0.5) * 1.2 },
      );
    }
    for (let i = 0; i < (big ? 18 : 12); i++) {
      const dir = randomDir();
      dir.y = Math.abs(dir.y) * 0.7 + 0.25;
      this.emit(pos, dir.multiplyScalar(power * (0.4 + Math.random() * 0.8)),
        { life: 0.3 + Math.random() * 0.3, sizeFrom: 0.9 * scale, sizeTo: 2.0 * scale,
          from: 0xfff0b0, to: 0xc02808, cell: CELL_FIRE_0, cells: CELL_FIRE_N,
          gravity: -5, drag: 3.0, spin: (Math.random() - 0.5) * 3 });
    }

    // smoke: lingers, rises, expands and goes dark — this is most of what reads
    // as an explosion a second after the flash is gone
    for (let i = 0; i < (big ? 14 : 9); i++) {
      const dir = randomDir();
      dir.y = Math.abs(dir.y) * 0.8 + 0.15;
      this.emit(pos, dir.multiplyScalar(3.2 * (0.5 + Math.random())),
        { layer: 1, life: 1.5 + Math.random() * 1.2,
          sizeFrom: 0.7 * scale, sizeTo: 2.4 * scale,
          from: 0x6b6058, to: 0x14141a,
          cell: CELL_SMOKE_0 + Math.floor(Math.random() * CELL_SMOKE_N), cells: 1,
          gravity: -1.1, drag: 1.8, spin: (Math.random() - 0.5) * 0.7,
          opacity: 0.4, fadeIn: 1 });
    }

    // embers that arc out and fall
    for (let i = 0; i < (big ? 24 : 14); i++) {
      this.emit(pos, randomDir().multiplyScalar(power * (0.5 + Math.random())),
        { life: 0.7 + Math.random() * 0.8, sizeFrom: 0.22, sizeTo: 0.1,
          from: 0xffd27a, to: 0xff3a08, cell: CELL_EMBER,
          gravity: 11, drag: 0.9 });
    }

    // ground shock ring, flat-on so it reads as a blast wave on the deck
    this.emit(this.scratchVec.copy(pos).setY(pos.y - 0.9), new THREE.Vector3(),
      { life: 0.32, sizeFrom: 0.8 * scale, sizeTo: 4.5 * scale,
        from: 0xffe2a8, to: 0xff6a20, cell: CELL_RING, opacity: 0.7, flat: true });

    this.flashLight.position.copy(pos).add(new THREE.Vector3(0, 2, 0));
    this.flashLight.intensity = big ? 260 : 140;
    this.flashTimer = 0.14;
    this.trauma = Math.min(1, this.trauma + (big ? 0.55 : 0.3));
  }

  sparks(pos: THREE.Vector3, n = 6, color = 0xffcf6a) {
    for (let i = 0; i < n; i++) {
      this.emit(pos, randomDir().multiplyScalar(5 + Math.random() * 7),
        { life: 0.15 + Math.random() * 0.22, sizeFrom: 0.5, sizeTo: 0.18,
          from: color, to: 0xff3300, cell: CELL_SPARK,
          gravity: 18, drag: 1, alignToVelocity: true });
    }
  }

  smokeTrail(pos: THREE.Vector3) {
    this.emit(pos, randomDir().multiplyScalar(0.5),
      { layer: 1, life: 0.8 + Math.random() * 0.5, sizeFrom: 0.35, sizeTo: 1.2,
        from: 0x9a8e7e, to: 0x2a2a30,
        cell: CELL_SMOKE_0 + Math.floor(Math.random() * CELL_SMOKE_N),
        gravity: -1.4, drag: 2, spin: (Math.random() - 0.5) * 1.4,
        opacity: 0.5, fadeIn: 1 });
  }

  /** flamethrower cone burst — call every step while firing */
  flameCone(pos: THREE.Vector3, dir: THREE.Vector3) {
    for (let i = 0; i < 3; i++) {
      const spread = randomDir().multiplyScalar(2.0);
      this.emit(pos, dir.clone().multiplyScalar(15 + Math.random() * 8).add(spread),
        { life: 0.3 + Math.random() * 0.22, sizeFrom: 0.5, sizeTo: 2.3,
          from: 0xfff0c0, to: 0xd03a06, cell: CELL_FIRE_0, cells: CELL_FIRE_N,
          gravity: -2.4, drag: 2.3, spin: (Math.random() - 0.5) * 2.5 });
    }
    // the plume drags soot behind it
    if (Math.random() < 0.55) {
      this.emit(pos.clone().addScaledVector(dir, 2.5), dir.clone().multiplyScalar(5),
        { layer: 1, life: 0.8 + Math.random() * 0.5, sizeFrom: 0.5, sizeTo: 1.7,
          from: 0x4a443e, to: 0x15151a,
          cell: CELL_SMOKE_0 + Math.floor(Math.random() * CELL_SMOKE_N),
          gravity: -1.6, drag: 1.8, spin: (Math.random() - 0.5) * 1,
          opacity: 0.4, fadeIn: 1 });
    }
  }

  /** expanding ground shockwave ring */
  shockwave(pos: THREE.Vector3) {
    this.emit(this.scratchVec.copy(pos).setY(pos.y + 0.25), new THREE.Vector3(),
      { life: 0.5, sizeFrom: 1, sizeTo: 11, from: 0xfff0d0, to: 0x9a6a28,
        cell: CELL_RING, opacity: 0.9, flat: true });
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2;
      this.emit(this.scratchVec.copy(pos).setY(pos.y + 0.4),
        new THREE.Vector3(Math.cos(a), 0.14, Math.sin(a)).multiplyScalar(20 + Math.random() * 7),
        { layer: 1, life: 0.6 + Math.random() * 0.4, sizeFrom: 0.5, sizeTo: 1.8,
          from: 0xbfae8c, to: 0x4a3a18,
          cell: CELL_SMOKE_0 + Math.floor(Math.random() * CELL_SMOKE_N),
          gravity: 5, drag: 2.6, spin: (Math.random() - 0.5) * 1.6,
          opacity: 0.6, fadeIn: 1 });
    }
    this.trauma = Math.min(1, this.trauma + 0.5);
  }

  turboFlame(pos: THREE.Vector3, backDir: THREE.Vector3) {
    this.emit(pos, backDir.clone().multiplyScalar(8 + Math.random() * 4)
      .add(randomDir().multiplyScalar(1.0)),
      { life: 0.16 + Math.random() * 0.12, sizeFrom: 0.62, sizeTo: 1.15,
        from: 0xffffff, to: 0xff8a10, cell: CELL_FIRE_0, cells: CELL_FIRE_N,
        drag: 2, spin: (Math.random() - 0.5) * 4 });
  }

  /** engine fire licking out of a wrecked car — `severity` 0..1, rate per second */
  engineFire(pos: THREE.Vector3, severity: number, dt: number) {
    if (Math.random() > (18 + severity * 30) * dt) return;
    this.emit(pos, randomDir().multiplyScalar(0.8).setY(1.6 + Math.random() * 1.6),
      { life: 0.26 + Math.random() * 0.2,
        sizeFrom: 0.32 + severity * 0.3, sizeTo: 0.7 + severity * 0.6,
        from: 0xffe6a0, to: 0xc83a08, cell: CELL_FIRE_0, cells: CELL_FIRE_N,
        gravity: -3.2, drag: 1.8, spin: (Math.random() - 0.5) * 3 });
  }

  /**
   * Power-up grabbed: a ring that snaps outward, a column of sparks rushing up,
   * and a flash in the pickup's own colour. The acquire used to be a 90ms
   * implosion with no feedback at all, so collecting something felt the same as
   * driving over a kerb.
   */
  pickupBurst(pos: THREE.Vector3, color: number) {
    this.emit(this.scratchVec.copy(pos).setY(pos.y - 0.6), new THREE.Vector3(),
      { life: 0.42, sizeFrom: 0.6, sizeTo: 6.5, from: color, to: color,
        cell: CELL_RING, opacity: 0.95, flat: true });
    this.emit(pos, new THREE.Vector3(),
      { life: 0.25, sizeFrom: 2.4, sizeTo: 0.4, from: 0xffffff, to: color,
        cell: CELL_GLOW, opacity: 0.9 });
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      this.emit(pos,
        new THREE.Vector3(Math.cos(a) * 3.2, 6 + Math.random() * 5, Math.sin(a) * 3.2),
        { life: 0.45 + Math.random() * 0.3, sizeFrom: 0.3, sizeTo: 0.08,
          from: 0xffffff, to: color, cell: CELL_EMBER, gravity: 7, drag: 1.1 });
    }
  }

  /** muzzle flash at a gun barrel, pointing down the shot */
  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3) {
    this.emit(pos, dir.clone().multiplyScalar(2),
      { life: 0.06, sizeFrom: 0.85, sizeTo: 0.45,
        from: 0xfff4c8, to: 0xffa030, cell: CELL_GLOW, drag: 6 });
    for (let i = 0; i < 2; i++) {
      this.emit(pos, dir.clone().multiplyScalar(9 + Math.random() * 6)
        .add(randomDir().multiplyScalar(2)),
        { life: 0.1 + Math.random() * 0.08, sizeFrom: 0.35, sizeTo: 0.12,
          from: 0xffe6a0, to: 0xff5a10, cell: CELL_SPARK,
          gravity: 6, drag: 2, alignToVelocity: true });
    }
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color = 0xffd070) {
    const t = this.tracers.find((t) => t.life <= 0);
    if (!t) return;
    const posAttr = t.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    posAttr.setXYZ(0, from.x, from.y, from.z);
    posAttr.setXYZ(1, to.x, to.y, to.z);
    posAttr.needsUpdate = true;
    t.mat.color.setHex(color);
    t.life = 0.07;
    t.mat.opacity = 0.9;
    t.line.visible = true;
  }

  /**
   * Position a named continuous light, or pass pos=null to switch it off.
   * Lights are created lazily and reused, so this is safe to call every frame.
   * Flames and turbo plumes previously emitted no light at all, which read as
   * fake at night — the glow is what sells them as a real light source.
   */
  glow(key: string, pos: THREE.Vector3 | null, color: number, intensity: number, distance: number) {
    let l = this.glows.get(key);
    if (!l) {
      if (!pos || !this.glowScene) return;
      l = new THREE.PointLight(color, 0, distance, 2);
      this.glowScene.add(l);
      this.glows.set(key, l);
    }
    if (!pos) { l.intensity = 0; return; }
    l.color.setHex(color);
    l.distance = distance;
    l.position.copy(pos);
    // ease in/out so a flicker of input doesn't pop the light
    l.intensity += (intensity - l.intensity) * 0.35;
  }

  update(dt: number) {
    this.additive.begin();
    this.alpha.begin();

    for (const p of this.particles) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; continue; }

      p.vel.y -= p.gravity * dt;
      p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      p.pos.addScaledVector(p.vel, dt);
      p.rot += p.rotVel * dt;

      const t = 1 - p.life / p.maxLife;             // 0 at birth, 1 at death
      const size = p.sizeFrom + (p.sizeTo - p.sizeFrom) * t;
      // smoke blooms in over its first fifth, everything else just fades out
      const fade = p.fadeIn > 0
        ? Math.min(1, t / 0.2) * (1 - Math.max(0, (t - 0.35) / 0.65))
        : 1 - t;
      this.scratchColor.copy(p.colorFrom).lerp(p.colorTo, t);
      const cell = p.cells > 1
        ? p.cell + Math.min(p.cells - 1, Math.floor(t * p.cells))
        : p.cell;
      const rot = p.alignToVelocity
        ? Math.atan2(p.vel.y, Math.hypot(p.vel.x, p.vel.z)) - Math.PI / 2
        : p.rot;

      const batch = p.layer === 1 ? this.alpha : this.additive;
      batch.write(p.pos, size, rot, cell, fade * p.opacity, this.scratchColor, p.flat);
    }

    this.additive.end();
    this.alpha.end();

    for (const t of this.tracers) {
      if (t.life > 0) {
        t.life -= dt;
        t.mat.opacity = Math.max(0, t.life / 0.07) * 0.9;
        if (t.life <= 0) t.line.visible = false;
      }
    }

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      this.flashLight.intensity *= Math.max(0, this.flashTimer / 0.14);
      if (this.flashTimer <= 0) this.flashLight.intensity = 0;
    }

    this.trauma = Math.max(0, this.trauma - dt * 1.6);
  }
}

function randomDir(): THREE.Vector3 {
  const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
  return v.lengthSq() < 0.001 ? v.set(0, 1, 0) : v.normalize();
}
