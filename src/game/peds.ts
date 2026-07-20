import * as THREE from 'three';
import type { Vehicle } from './vehicle';

/** Rectangular spawn/wander zone (sidewalk strip or plaza pocket). */
export interface PedZone { x: number; z: number; hx: number; hz: number; }

interface Ped {
  mesh: THREE.Group;
  pos: THREE.Vector3;
  target: THREE.Vector3;
  zone: PedZone;
  state: 'walk' | 'flee' | 'dead';
  respawnT: number;
  bobPhase: number;
}

const COUNT = 26;
const WALK_SPEED = 1.5;
const FLEE_SPEED = 4.5;
const FLEE_RADIUS = 14;
const SPLAT_RADIUS = 1.5;
const SPLAT_MIN_SPEED = 8;
const RESPAWN_MIN_DIST = 40;

const SHIRT_COLORS = [0xc0563a, 0x4a7a5c, 0x5c6a9c, 0x9c8a4a, 0x7a4a6a, 0x4a8a8a, 0x8a5a3a];

const _v = new THREE.Vector3();

function buildPedMesh(): THREE.Group {
  const g = new THREE.Group();
  const shirt = SHIRT_COLORS[Math.floor(Math.random() * SHIRT_COLORS.length)];
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.75, 0.26),
    new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.9 }),
  );
  body.position.y = 0.85;
  body.castShadow = true;
  const legs = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.5, 0.22),
    new THREE.MeshStandardMaterial({ color: 0x2a2a32, roughness: 0.9 }),
  );
  legs.position.y = 0.25;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xd8b090, roughness: 0.8 }),
  );
  head.position.y = 1.42;
  head.castShadow = true;
  g.add(legs, body, head);
  return g;
}

function randomPointIn(zone: PedZone, out: THREE.Vector3): THREE.Vector3 {
  out.set(
    zone.x + (Math.random() * 2 - 1) * zone.hx,
    0,
    zone.z + (Math.random() * 2 - 1) * zone.hz,
  );
  return out;
}

export class PedManager {
  private peds: Ped[] = [];
  private zones: PedZone[];
  private time = 0;

  constructor(scene: THREE.Scene, zones: PedZone[]) {
    this.zones = zones;
    for (let i = 0; i < COUNT; i++) {
      const zone = zones[i % zones.length];
      const mesh = buildPedMesh();
      const pos = randomPointIn(zone, new THREE.Vector3());
      mesh.position.copy(pos);
      scene.add(mesh);
      this.peds.push({
        mesh, pos, zone,
        target: randomPointIn(zone, new THREE.Vector3()),
        state: 'walk',
        respawnT: 0,
        bobPhase: Math.random() * 10,
      });
    }
  }

  /** onSplat(vehicle, position) fires when a vehicle flattens a pedestrian */
  update(dt: number, vehicles: Vehicle[], onSplat: (v: Vehicle, pos: THREE.Vector3) => void) {
    this.time += dt;
    for (const p of this.peds) {
      if (p.state === 'dead') {
        p.respawnT -= dt;
        if (p.respawnT <= 0) {
          // respawn only well away from every vehicle (anti-farm)
          const zone = this.zones[Math.floor(Math.random() * this.zones.length)];
          randomPointIn(zone, _v);
          let clear = true;
          for (const veh of vehicles) {
            if (veh.alive && veh.position.distanceToSquared(_v) < RESPAWN_MIN_DIST * RESPAWN_MIN_DIST) { clear = false; break; }
          }
          if (clear) {
            p.zone = zone;
            p.pos.copy(_v);
            randomPointIn(zone, p.target);
            p.state = 'walk';
            p.mesh.visible = true;
          } else {
            p.respawnT = 1.5; // spot contested — try again shortly
          }
        }
        continue;
      }

      // nearest vehicle drives fear
      let nearest: Vehicle | null = null;
      let nearestD2 = Infinity;
      for (const veh of vehicles) {
        if (!veh.alive) continue;
        const d2 = veh.position.distanceToSquared(p.pos);
        if (d2 < nearestD2) { nearestD2 = d2; nearest = veh; }
      }

      // splat check
      if (nearest && nearestD2 < SPLAT_RADIUS * SPLAT_RADIUS && nearest.speed > SPLAT_MIN_SPEED) {
        p.state = 'dead';
        p.respawnT = 10 + Math.random() * 6;
        p.mesh.visible = false;
        onSplat(nearest, p.pos.clone());
        continue;
      }

      // behavior
      if (nearest && nearestD2 < FLEE_RADIUS * FLEE_RADIUS) {
        p.state = 'flee';
        _v.copy(p.pos).sub(nearest.position);
        _v.y = 0;
        _v.normalize();
        p.pos.addScaledVector(_v, FLEE_SPEED * dt);
      } else {
        if (p.state === 'flee') {
          p.state = 'walk';
          randomPointIn(p.zone, p.target);
        }
        _v.copy(p.target).sub(p.pos);
        _v.y = 0;
        if (_v.lengthSq() < 1) {
          randomPointIn(p.zone, p.target);
        } else {
          _v.normalize();
          p.pos.addScaledVector(_v, WALK_SPEED * dt);
        }
      }
      // stay inside the arena
      p.pos.x = THREE.MathUtils.clamp(p.pos.x, -118, 118);
      p.pos.z = THREE.MathUtils.clamp(p.pos.z, -118, 118);

      p.mesh.position.set(p.pos.x, Math.abs(Math.sin(this.time * (p.state === 'flee' ? 14 : 7) + p.bobPhase)) * 0.08, p.pos.z);
      if (_v.lengthSq() > 0.001) p.mesh.rotation.y = Math.atan2(_v.x, _v.z);
    }
  }
}
