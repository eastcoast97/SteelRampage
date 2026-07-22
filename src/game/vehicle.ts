import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { CarSpec } from './specs';

export interface VehicleInput {
  throttle: number;   // -1..1
  steer: number;      // -1..1, positive = left
  handbrake: boolean;
  turbo: boolean;
  fireMG: boolean;
  fireMissile: boolean;
  dropMine: boolean;
  special: boolean;
}

const GRAVITY = 25;
// suspension geometry scales with the 80% vehicle downscale (see LEVEL-DESIGN.md)
const REST_LEN = 0.44;
const WHEEL_RADIUS = 0.26;

const _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _gripPoint = new THREE.Vector3();
const _steerQ = new THREE.Quaternion();

export class Vehicle {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  spec: CarSpec;
  name: string;
  isBot: boolean;

  health: number;
  /** machine gun is the only default weapon — missiles come from pickups */
  missiles = 0;
  turboMeter: number;
  score = 0;
  deaths = 0;
  alive = true;
  respawnTimer = 0;

  input: VehicleInput = { throttle: 0, steer: 0, handbrake: false, turbo: false, fireMG: false, fireMissile: false, dropMine: false, special: false };

  mgCooldown = 0;
  missileCooldown = 0;
  mineCooldown = 0;
  /** brief invulnerability after (re)spawn; cleared when firing */
  spawnProtection = 3;

  // power-up state
  shieldTime = 0;
  overdriveTime = 0;
  minesAmmo = 0;
  shieldMesh: THREE.Mesh | null = null;
  /** flare timer — the bubble flashes when it eats a hit */
  shieldFlash = 0;

  // per-vehicle special weapon (starts charged)
  /** EARNED resource: starts empty; +25% per kill or special pickup, 3-kill
   *  streak fills it instantly. No passive regen. */
  specialEnergy = 0;
  killStreak = 0;
  specialActiveTime = 0;
  turretTimer = 0;
  /** raw special damage dealt per victim this activation — enforces the
   *  "no special ever out-damages a targeted missile" invariant */
  specialLedger = new Map<Vehicle, number>();
  /** true while a remote bomb is out — pauses energy recharge */
  bombOut = false;

  // match-mode state
  lives = 0;
  eliminated = false;
  lockTarget: Vehicle | null = null;
  /** acquisition state: candidate being tracked + progress 0..1 */
  lockCandidate: Vehicle | null = null;
  lockProgress = 0;
  lastDamager: Vehicle | null = null;
  lastDamageTime = 0;
  /** last time this vehicle earned a pedestrian heal (rate limit) */
  pedHealAt = -10;
  /** fired after mitigation with the damage actually applied */
  onDamage: ((victim: Vehicle, amount: number, attacker: Vehicle | null) => void) | null = null;

  /** per-boost-pad rate limit: pad index → last trigger time */
  padCooldowns = new Map<number, number>();

  /** visual */
  mesh: THREE.Group | null = null;
  wheels: THREE.Object3D[] = [];
  wheelCompression = [0, 0, 0, 0];
  wheelSteer = 0;
  wheelSpin = 0;

  grounded = false;
  /** stunt state */
  airTime = 0;
  landingBoostT = 0;
  drifting = false;
  rearContactL = new THREE.Vector3();
  rearContactR = new THREE.Vector3();
  onLanding: ((v: Vehicle, perfect: boolean, fallSpeed: number) => void) | null = null;
  private prevGrounded = true;
  private impactVy = 0;
  private flippedTime = 0;
  private mass: number;
  private wheelAnchors: THREE.Vector3[];
  private steerCurrent = 0;

  constructor(world: RAPIER.World, spec: CarSpec, pos: THREE.Vector3, yaw: number, name: string, isBot: boolean) {
    this.spec = spec;
    this.name = name;
    this.isBot = isBot;
    this.health = spec.maxHealth;
    this.turboMeter = spec.turboMax;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation(quatFromYaw(yaw))
      .setAngularDamping(1.2)
      .setLinearDamping(0.08)
      .setCcdEnabled(true);
    this.body = world.createRigidBody(bodyDesc);

    const colDesc = RAPIER.ColliderDesc.cuboid(spec.size.x, spec.size.y, spec.size.z)
      .setDensity(1.0)
      .setFriction(0.35)
      .setRestitution(0.25);
    this.collider = world.createCollider(colDesc, this.body);
    this.mass = this.body.mass();

    const { x: sx, y: sy, z: sz } = spec.size;
    this.wheelAnchors = [
      new THREE.Vector3(-sx * 0.85, -sy, -sz * 0.72), // front-left
      new THREE.Vector3(sx * 0.85, -sy, -sz * 0.72),  // front-right
      new THREE.Vector3(-sx * 0.85, -sy, sz * 0.72),  // rear-left
      new THREE.Vector3(sx * 0.85, -sy, sz * 0.72),   // rear-right
    ];
  }

  get position(): THREE.Vector3 {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  get quaternion(): THREE.Quaternion {
    const r = this.body.rotation();
    return new THREE.Quaternion(r.x, r.y, r.z, r.w);
  }

  get forward(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(this.quaternion);
  }

  get velocity(): THREE.Vector3 {
    const v = this.body.linvel();
    return new THREE.Vector3(v.x, v.y, v.z);
  }

  get speed(): number {
    return this.velocity.length();
  }

  get forwardSpeed(): number {
    return this.velocity.dot(this.forward);
  }

  velocityAtPoint(point: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const lv = this.body.linvel();
    const av = this.body.angvel();
    const t = this.body.translation();
    _tmp2.set(point.x - t.x, point.y - t.y, point.z - t.z);
    out.set(
      lv.x + av.y * _tmp2.z - av.z * _tmp2.y,
      lv.y + av.z * _tmp2.x - av.x * _tmp2.z,
      lv.z + av.x * _tmp2.y - av.y * _tmp2.x,
    );
    return out;
  }

  update(dt: number, world: RAPIER.World) {
    if (!this.alive) return;

    const t = this.body.translation();
    const r = this.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _fwd.set(0, 0, -1).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);

    // smooth steering toward input
    const speed = this.speed;
    const steerLimit = this.spec.steerMax / (1 + speed * 0.032);
    const steerTarget = this.input.steer * steerLimit;
    const steerRate = 5.5;
    this.steerCurrent += THREE.MathUtils.clamp(steerTarget - this.steerCurrent, -steerRate * dt, steerRate * dt);
    this.wheelSteer = this.steerCurrent;

    const maxToi = REST_LEN + WHEEL_RADIUS;
    let groundedWheels = 0;
    let rearLatSlip = 0;
    if (!this.grounded) this.impactVy = this.body.linvel().y; // vy just before touchdown
    const kSpring = (this.mass * GRAVITY) / (4 * 0.42 * maxToi) * 2.4;
    const kDamp = this.mass * 2.4;

    const turboActive = this.input.turbo && this.turboMeter > 0 && this.input.throttle > 0;

    for (let i = 0; i < 4; i++) {
      const anchor = this.wheelAnchors[i];
      _p.copy(anchor).applyQuaternion(_q).add(_tmp.set(t.x, t.y, t.z));

      const ray = new RAPIER.Ray(
        { x: _p.x, y: _p.y, z: _p.z },
        { x: -_up.x, y: -_up.y, z: -_up.z },
      );
      const hit = world.castRay(ray, maxToi, true, undefined, undefined, undefined, this.body);
      if (!hit) {
        this.wheelCompression[i] = 0;
        continue;
      }
      const toi = (hit as any).timeOfImpact ?? (hit as any).toi;
      const compression = maxToi - toi;
      this.wheelCompression[i] = compression;
      groundedWheels++;

      // --- suspension spring ---
      this.velocityAtPoint(_p, _v);
      const suspVel = _v.dot(_up);
      let force = kSpring * compression - kDamp * suspVel;
      if (force < 0) force = 0;
      this.applyImpulseAt(_up, force * dt, _p);

      // --- traction ---
      const isFront = i < 2;
      const wheelFwd = _tmp2.copy(_fwd);
      if (isFront && Math.abs(this.steerCurrent) > 0.001) {
        _steerQ.setFromAxisAngle(_up, this.steerCurrent);
        wheelFwd.applyQuaternion(_steerQ);
      }
      const side = new THREE.Vector3().crossVectors(_up, wheelFwd).normalize();

      // lateral grip — applied at center-of-mass height (not at the contact
      // patch) so hard cornering yaws the car instead of rolling it over
      const latVel = _v.dot(side);
      if (!isFront) {
        rearLatSlip += Math.abs(latVel);
        (i === 2 ? this.rearContactL : this.rearContactR).copy(_p).addScaledVector(_up, -toi + 0.05);
      }
      let grip = this.spec.grip;
      if (this.input.handbrake) grip = isFront ? grip : 1.4;
      const gripImpulse = -latVel * Math.min(grip * dt, 1) * (this.mass / 4);
      _gripPoint.set(_p.x, t.y, _p.z);
      this.applyImpulseAt(side, gripImpulse, _gripPoint);

      // drive force (AWD)
      let throttle = this.input.throttle;
      if (throttle !== 0 && !this.input.handbrake) {
        const fwdSpeed = _v.dot(wheelFwd);
        let accel = this.spec.accel;
        if (throttle < 0) accel = fwdSpeed > 1 ? accel * 1.6 : accel * 0.55; // brake vs reverse
        if (turboActive && throttle > 0) accel *= 1.85;
        if (this.landingBoostT > 0 && throttle > 0) accel *= 1.5; // perfect-landing reward
        this.applyImpulseAt(wheelFwd, throttle * accel * (this.mass / 4) * dt, _p);
      } else if (this.input.handbrake && !isFront) {
        // handbrake: kill rear wheel forward velocity a bit
        const fwdSpeed = _v.dot(wheelFwd);
        this.applyImpulseAt(wheelFwd, -fwdSpeed * Math.min(3 * dt, 1) * (this.mass / 4), _p);
      }
    }

    this.grounded = groundedWheels >= 2;
    this.drifting = this.grounded && speed > 9 && rearLatSlip / 2 > 3.6;

    // landing detection: touchdown after real airtime
    if (!this.grounded) {
      this.airTime += dt;
    } else {
      if (!this.prevGrounded && this.airTime > 0.35) {
        const fallSpeed = Math.max(0, -this.impactVy);
        const perfect = _up.y > 0.93;
        if (perfect) this.landingBoostT = 1;
        this.onLanding?.(this, perfect, fallSpeed);
      }
      this.airTime = 0;
    }
    this.prevGrounded = this.grounded;
    this.landingBoostT = Math.max(0, this.landingBoostT - dt);

    // turbo meter
    if (turboActive) {
      this.turboMeter = Math.max(0, this.turboMeter - dt);
    } else if (!this.input.turbo) {
      this.turboMeter = Math.min(this.spec.turboMax, this.turboMeter + dt * 0.35);
    }

    // quadratic drag (sets top speed)
    let topSpeed = turboActive ? this.spec.topSpeed * 1.35 : this.spec.topSpeed;
    if (this.landingBoostT > 0) topSpeed *= 1.15;
    const dragK = this.spec.accel / (topSpeed * topSpeed);
    const vel = this.velocity;
    const vLen = vel.length();
    if (vLen > 0.5) {
      const dragImpulse = vel.clone().multiplyScalar(-dragK * vLen * this.mass * dt / Math.max(vLen, 0.001) * vLen);
      // horizontal drag only (don't fight gravity)
      dragImpulse.y *= 0.2;
      this.body.applyImpulse(dragImpulse, true);
    }

    // arcade yaw-rate control: steer commands a target yaw rate; a torque
    // drives the car to it and actively kills residual spin (no spin-outs)
    if (this.grounded) {
      const fwdSpd = this.forwardSpeed;
      const desiredYaw = this.steerCurrent * 5.0 * THREE.MathUtils.clamp(fwdSpd / 6, -1, 1);
      const av = this.body.angvel();
      const yawVel = av.x * _up.x + av.y * _up.y + av.z * _up.z;
      const err = THREE.MathUtils.clamp(desiredYaw - yawVel, -3, 3);
      const inertiaY = (this.mass / 12) * ((2 * this.spec.size.x) ** 2 + (2 * this.spec.size.z) ** 2);
      const k = inertiaY * 9 * err * dt;
      this.body.applyTorqueImpulse({ x: _up.x * k, y: _up.y * k, z: _up.z * k }, true);
    }

    // self-level: gentle in air, firm anti-roll on the ground (scales with
    // speed so turbo-speed cornering can't tip the car)
    {
      const airControl = !this.grounded && (Math.abs(this.input.throttle) > 0.1 || Math.abs(this.input.steer) > 0.1);
      const corr = new THREE.Vector3().crossVectors(_up, new THREE.Vector3(0, 1, 0));
      // player mid-air inputs override most of the auto-level
      const k = this.mass * (this.grounded ? 3.2 + speed * 0.1 : airControl ? 0.35 : 1.1);
      this.body.applyTorqueImpulse({ x: corr.x * k * dt, y: corr.y * k * dt, z: corr.z * k * dt }, true);

      // mid-air stunt control: W/S pitches, A/D rolls — self-correct before landing
      if (!this.grounded) {
        const ka = this.mass * 2.2 * dt;
        if (Math.abs(this.input.throttle) > 0.1) {
          const pitch = -this.input.throttle * ka; // W = nose down, S = nose up
          this.body.applyTorqueImpulse({ x: _right.x * pitch, y: _right.y * pitch, z: _right.z * pitch }, true);
        }
        if (Math.abs(this.input.steer) > 0.1) {
          const roll = this.input.steer * ka * 0.9;
          this.body.applyTorqueImpulse({ x: _fwd.x * roll, y: _fwd.y * roll, z: _fwd.z * roll }, true);
        }
      }
    }

    // flip recovery
    if (_up.y < 0.25 && speed < 4) {
      this.flippedTime += dt;
      if (this.flippedTime > 2.2) this.unflip();
    } else {
      this.flippedTime = 0;
    }

    // wheel spin visual
    this.wheelSpin += (this.forwardSpeed / WHEEL_RADIUS) * dt;

    // cooldowns & power-up timers
    this.mgCooldown = Math.max(0, this.mgCooldown - dt);
    this.missileCooldown = Math.max(0, this.missileCooldown - dt);
    this.mineCooldown = Math.max(0, this.mineCooldown - dt);
    this.spawnProtection = Math.max(0, this.spawnProtection - dt);
    this.shieldTime = Math.max(0, this.shieldTime - dt);
    this.shieldFlash = Math.max(0, this.shieldFlash - dt);
    this.overdriveTime = Math.max(0, this.overdriveTime - dt);
    this.specialActiveTime = Math.max(0, this.specialActiveTime - dt);
    // NOTE: no passive special recharge — energy comes from kills and pickups only
  }

  private applyImpulseAt(dir: THREE.Vector3, magnitude: number, point: THREE.Vector3) {
    this.body.applyImpulseAtPoint(
      { x: dir.x * magnitude, y: dir.y * magnitude, z: dir.z * magnitude },
      { x: point.x, y: point.y, z: point.z },
      true,
    );
  }

  unflip() {
    const t = this.body.translation();
    const r = this.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    const fwd = _fwd.set(0, 0, -1).applyQuaternion(_q);
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    this.body.setTranslation({ x: t.x, y: t.y + 1.6, z: t.z }, true);
    this.body.setRotation(quatFromYaw(yaw), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.flippedTime = 0;
  }

  takeDamage(amount: number, attacker: Vehicle | null, now: number): boolean {
    if (!this.alive || this.spawnProtection > 0) return false;
    if (this.shieldTime > 0) { this.shieldFlash = 0.18; return false; } // shield = untouchable, flare on impact
    // armor mitigation: percentage reduction with diminishing returns.
    // effectiveHP = 100 * (1 + armor/100); armor never zeroes out chip damage.
    amount *= 100 / (100 + this.spec.armor);
    this.health -= amount;
    this.onDamage?.(this, amount, attacker);
    if (attacker && attacker !== this) {
      this.lastDamager = attacker;
      this.lastDamageTime = now;
    }
    if (this.health <= 0) {
      this.health = 0;
      return true; // killed
    }
    return false;
  }

  respawn(pos: THREE.Vector3, yaw: number) {
    this.health = this.spec.maxHealth;
    this.missiles = 0;
    this.turboMeter = this.spec.turboMax;
    // specialEnergy carries across death (it's earned) — but the streak breaks
    this.killStreak = 0;
    this.specialActiveTime = 0;
    this.bombOut = false;
    this.alive = true;
    this.lastDamager = null;
    this.spawnProtection = 3;
    this.lockTarget = null;
    this.lockCandidate = null;
    this.lockProgress = 0;
    this.shieldTime = 0;
    this.overdriveTime = 0;
    this.minesAmmo = 0;
    this.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    this.body.setRotation(quatFromYaw(yaw), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    if (this.mesh) this.mesh.visible = true;
  }

  kill() {
    this.alive = false;
    this.deaths++;
    this.respawnTimer = 3;
    if (this.mesh) this.mesh.visible = false;
    // fling the hidden body out of the arena so it can't be hit
    this.body.setTranslation({ x: 0, y: -50 - Math.random() * 20, z: 0 }, false);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    this.body.sleep();
  }

  syncVisual() {
    if (!this.mesh) return;
    const t = this.body.translation();
    const r = this.body.rotation();
    this.mesh.position.set(t.x, t.y, t.z);
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    // wheels
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      const comp = this.wheelCompression[i];
      const drop = comp > 0 ? REST_LEN + WHEEL_RADIUS - comp - WHEEL_RADIUS : REST_LEN * 0.7;
      w.position.y = this.wheelAnchors[i].y - drop;
      w.rotation.set(0, i < 2 ? this.wheelSteer : 0, 0);
      w.children[0]?.rotation.set(this.wheelSpin % (Math.PI * 2), 0, 0);
    }
  }
}

export function quatFromYaw(yaw: number): RAPIER.Quaternion {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}
