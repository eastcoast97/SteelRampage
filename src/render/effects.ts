import * as THREE from 'three';

const MAX_PARTICLES = 1600;
const MAX_TRACERS = 28;

interface Particle {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  colorFrom: THREE.Color;
  colorTo: THREE.Color;
  gravity: number;
  drag: number;
}

function makeDotTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Effects {
  private particles: Particle[] = [];
  private geo: THREE.BufferGeometry;
  private positions: Float32Array;
  private colors: Float32Array;
  private points: THREE.Points;
  private cursor = 0;

  private tracers: { line: THREE.Line; mat: THREE.LineBasicMaterial; life: number }[] = [];
  private flashLight: THREE.PointLight;
  private flashTimer = 0;

  /** camera shake 0..1 */
  trauma = 0;

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        alive: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0, maxLife: 1,
        colorFrom: new THREE.Color(),
        colorTo: new THREE.Color(),
        gravity: 0, drag: 0,
      });
    }
    this.geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.positions.fill(-10000);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.85,
      map: makeDotTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);

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
  }

  private emit(
    pos: THREE.Vector3, vel: THREE.Vector3,
    life: number, from: number, to: number,
    gravity = 0, drag = 0,
  ) {
    const p = this.particles[this.cursor];
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    p.alive = true;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.life = life;
    p.maxLife = life;
    p.colorFrom.setHex(from);
    p.colorTo.setHex(to);
    p.gravity = gravity;
    p.drag = drag;
  }

  explosion(pos: THREE.Vector3, big = false) {
    const nFire = big ? 60 : 34;
    const nSmoke = big ? 26 : 12;
    const power = big ? 17 : 11;
    for (let i = 0; i < nFire; i++) {
      const dir = randomDir();
      dir.y = Math.abs(dir.y) * 0.8 + 0.2;
      this.emit(
        pos, dir.multiplyScalar(power * (0.3 + Math.random() * 0.9)),
        0.35 + Math.random() * 0.5,
        Math.random() > 0.5 ? 0xffe08a : 0xff9030, 0xa01505,
        -6, 2.2,
      );
    }
    for (let i = 0; i < nSmoke; i++) {
      const dir = randomDir();
      dir.y = Math.abs(dir.y);
      this.emit(
        pos, dir.multiplyScalar(4 * (0.4 + Math.random())),
        0.9 + Math.random() * 0.9,
        0x554a44, 0x0a0a0c,
        3.2, 1.4,
      );
    }
    this.flashLight.position.copy(pos).add(new THREE.Vector3(0, 2, 0));
    this.flashLight.intensity = big ? 260 : 140;
    this.flashTimer = 0.14;
    this.trauma = Math.min(1, this.trauma + (big ? 0.55 : 0.3));
  }

  sparks(pos: THREE.Vector3, n = 6, color = 0xffcf6a) {
    for (let i = 0; i < n; i++) {
      this.emit(
        pos, randomDir().multiplyScalar(5 + Math.random() * 7),
        0.15 + Math.random() * 0.2,
        color, 0xff3300,
        18, 1,
      );
    }
  }

  smokeTrail(pos: THREE.Vector3) {
    this.emit(
      pos,
      randomDir().multiplyScalar(0.6),
      0.5 + Math.random() * 0.3,
      0xbbaa88, 0x222226,
      2.0, 2,
    );
  }

  /** flamethrower cone burst — call every step while firing */
  flameCone(pos: THREE.Vector3, dir: THREE.Vector3) {
    for (let i = 0; i < 3; i++) {
      const spread = randomDir().multiplyScalar(2.2);
      this.emit(
        pos,
        dir.clone().multiplyScalar(16 + Math.random() * 8).add(spread),
        0.28 + Math.random() * 0.22,
        Math.random() > 0.4 ? 0xffc040 : 0xff6018, 0x881005,
        -3, 2.6,
      );
    }
  }

  /** expanding ground shockwave ring */
  shockwave(pos: THREE.Vector3) {
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(a), 0.12, Math.sin(a));
      this.emit(
        pos.clone().add(new THREE.Vector3(0, 0.4, 0)),
        dir.multiplyScalar(22 + Math.random() * 6),
        0.4 + Math.random() * 0.25,
        0xd8c8a0, 0x604818,
        14, 2.8,
      );
    }
    this.trauma = Math.min(1, this.trauma + 0.5);
  }

  turboFlame(pos: THREE.Vector3, backDir: THREE.Vector3) {
    this.emit(
      pos,
      backDir.clone().multiplyScalar(9 + Math.random() * 4).add(randomDir().multiplyScalar(1.2)),
      0.14 + Math.random() * 0.12,
      0xfff6b0, 0xffa000,
      0, 2,
    );
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

  update(dt: number) {
    const posAttr = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = this.geo.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        posAttr.setXYZ(i, -10000, -10000, -10000);
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      p.pos.addScaledVector(p.vel, dt);
      const t = 1 - p.life / p.maxLife;
      posAttr.setXYZ(i, p.pos.x, p.pos.y, p.pos.z);
      const r = p.colorFrom.r + (p.colorTo.r - p.colorFrom.r) * t;
      const g = p.colorFrom.g + (p.colorTo.g - p.colorFrom.g) * t;
      const b = p.colorFrom.b + (p.colorTo.b - p.colorFrom.b) * t;
      const fade = p.life / p.maxLife;
      colAttr.setXYZ(i, r * fade, g * fade, b * fade);
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;

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
