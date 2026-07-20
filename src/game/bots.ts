import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Vehicle } from './vehicle';
import type { PickupManager } from './pickups';

const _toTarget = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export class BotController {
  vehicle: Vehicle;
  private target: Vehicle | null = null;
  private retargetTimer = 0;
  private stuckTimer = 0;
  private reverseTimer = 0;
  private burstTimer = 0;
  private burstOn = false;
  private aggression: number;
  private goalPickup: THREE.Vector3 | null = null;

  constructor(vehicle: Vehicle) {
    this.vehicle = vehicle;
    this.aggression = 0.65 + Math.random() * 0.35;
  }

  update(dt: number, vehicles: Vehicle[], player: Vehicle, pickups: PickupManager, world: RAPIER.World) {
    const v = this.vehicle;
    if (!v.alive) return;

    this.retargetTimer -= dt;
    if (this.retargetTimer <= 0) {
      this.retargetTimer = 1.6 + Math.random();
      this.pickTarget(vehicles, player);
      this.pickGoalPickup(pickups);
    }

    const pos = v.position;
    const fwd = _fwd.copy(v.forward);
    fwd.y = 0;
    fwd.normalize();

    // decide where to drive
    let goal: THREE.Vector3 | null = this.goalPickup;
    if (!goal && this.target?.alive) goal = this.target.position;
    if (!goal) goal = new THREE.Vector3(0, 0, 0);

    _toTarget.copy(goal).sub(pos);
    _toTarget.y = 0;
    const dist = _toTarget.length();
    _toTarget.normalize();

    // signed angle to goal around up axis
    const cross = fwd.x * _toTarget.z - fwd.z * _toTarget.x;  // = (fwd × to)·(-Y)... sign handled below
    const dot = THREE.MathUtils.clamp(fwd.dot(_toTarget), -1, 1);
    let angle = Math.atan2(-cross, dot); // positive = goal is to the left

    // obstacle avoidance: short ray ahead
    const rayOrigin = { x: pos.x + fwd.x * 2.5, y: pos.y + 0.4, z: pos.z + fwd.z * 2.5 };
    const ray = new RAPIER.Ray(rayOrigin, { x: fwd.x, y: 0, z: fwd.z });
    const hit = world.castRay(ray, 9, true, undefined, undefined, undefined, v.body);
    if (hit && v.speed > 4) {
      angle += angle >= 0 ? 0.9 : -0.9;
    }

    // steering + throttle
    let steer = THREE.MathUtils.clamp(angle * 2.2, -1, 1);
    let throttle = 1;
    if (Math.abs(angle) > 1.9 && v.speed > 10) throttle = 0.25; // ease off in hard turns
    if (this.target?.alive && !this.goalPickup && dist < 14 && Math.abs(angle) < 0.5) {
      throttle = v.speed > 12 ? 0.3 : 0.7; // don't overshoot targets at close range
    }

    // unstuck logic
    if (v.speed < 1.2 && throttle > 0.5) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 1.4) {
        this.reverseTimer = 1.1;
        this.stuckTimer = 0;
      }
    } else {
      this.stuckTimer = Math.max(0, this.stuckTimer - dt);
    }
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      throttle = -1;
      steer = -steer;
    }

    v.input.throttle = throttle;
    v.input.steer = steer;
    v.input.handbrake = false;
    v.input.turbo = dist > 45 && Math.abs(angle) < 0.3 && v.turboMeter > 1;

    // reached pickup goal?
    if (this.goalPickup && pos.distanceTo(this.goalPickup) < 4) this.goalPickup = null;

    // --- combat ---
    v.input.fireMG = false;
    v.input.fireMissile = false;
    v.input.dropMine = false;
    v.input.special = false;
    // drop a mine when someone is chasing close behind
    if (v.minesAmmo > 0 && v.mineCooldown <= 0) {
      for (const e of vehicles) {
        if (e === v || !e.alive) continue;
        const toMe = _toTarget.copy(pos).sub(e.position);
        const d = toMe.length();
        if (d < 14 && d > 4 && fwd.dot(toMe.normalize()) > 0.6) {
          v.input.dropMine = true;
          break;
        }
      }
    }
    if (this.target?.alive) {
      const tPos = this.target.position;
      const tDist = pos.distanceTo(tPos);
      const toEnemy = _toTarget.copy(tPos).sub(pos).normalize();
      const facing = v.forward.dot(toEnemy);

      // MG burst fire
      this.burstTimer -= dt;
      if (this.burstTimer <= 0) {
        this.burstOn = !this.burstOn;
        this.burstTimer = this.burstOn ? 0.5 + Math.random() * 0.5 : 0.4 + (1 - this.aggression) * 0.8;
      }
      if (this.burstOn && tDist < 55 && facing > 0.93) v.input.fireMG = true;

      // missiles when locked
      if (v.missiles > 0 && v.lockTarget && tDist < 70 && Math.random() < this.aggression * 0.9) {
        v.input.fireMissile = true;
      }

      // special weapon usage — per-archetype heuristics
      if (v.specialEnergy >= 1 && v.specialActiveTime <= 0 && !v.bombOut) {
        const id = v.spec.specialId;
        if (
          (id === 'dash' && facing > 0.9 && tDist > 10 && tDist < 40) ||
          (id === 'minigun' && facing > 0.85 && tDist < 45) ||
          (id === 'flame' && facing > 0.82 && tDist < 11) ||
          (id === 'turret' && tDist < 40) ||
          (id === 'slam' && tDist < 9) ||
          (id === 'bomb' && facing > 0.7 && tDist < 30) ||
          (id === 'repair' && v.health < v.spec.maxHealth * 0.55) ||
          (id === 'minetrail' && facing < -0.5 && tDist < 18)
        ) {
          v.input.special = true;
        }
      }
      // minigun special is only useful if actually shooting
      if (v.spec.specialId === 'minigun' && v.specialActiveTime > 0 && tDist < 55 && facing > 0.88) {
        v.input.fireMG = true;
      }
    }
  }

  private pickTarget(vehicles: Vehicle[], player: Vehicle) {
    const v = this.vehicle;
    const pos = v.position;
    const enemies = vehicles.filter((e) => e !== v && e.alive);
    if (enemies.length === 0) { this.target = null; return; }
    // grudge: whoever hurt me recently
    if (v.lastDamager?.alive && Math.random() < 0.6) {
      this.target = v.lastDamager;
      return;
    }
    // slight bias toward the player — keeps the game personal
    if (player.alive && Math.random() < 0.3) {
      this.target = player;
      return;
    }
    enemies.sort((a, b) => a.position.distanceToSquared(pos) - b.position.distanceToSquared(pos));
    this.target = enemies[0];
  }

  private pickGoalPickup(pickups: PickupManager) {
    const v = this.vehicle;
    this.goalPickup = null;
    if (v.health < v.spec.maxHealth * 0.4) {
      const p = pickups.nearestActive('health', v.position);
      if (p && p.distanceTo(v.position) < 90) { this.goalPickup = p; return; }
    }
    if (v.missiles === 0 && Math.random() < 0.7) {
      const p = pickups.nearestActive('missiles', v.position);
      if (p && p.distanceTo(v.position) < 60) this.goalPickup = p;
    }
  }
}
