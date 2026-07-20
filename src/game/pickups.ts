import * as THREE from 'three';
import type { Vehicle } from './vehicle';

export type PickupType = 'health' | 'missiles' | 'turbo' | 'shield' | 'overdrive' | 'mines';

const RESPAWN_TIME: Record<PickupType, number> = {
  health: 11,
  missiles: 11,
  turbo: 9,
  shield: 18,
  overdrive: 22,
  mines: 14,
};

interface Pickup {
  type: PickupType;
  pos: THREE.Vector3;
  /** roaming pickups relocate among these sockets on each respawn */
  alts?: THREE.Vector3[];
  mesh: THREE.Group;
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  active: boolean;
  timer: number;
  /** >0 while playing the acquire implosion */
  shrinkT: number;
  /** >0 while playing the respawn pop-in */
  popT: number;
}

/** a pickup will not respawn while a living vehicle camps within this radius */
const HOLD_RADIUS = 12;

// design system palette — see docs/DESIGN-SYSTEM.md
export const PICKUP_COLORS: Record<PickupType, number> = {
  health: 0x2ee86c,    // Vital Green
  missiles: 0xff6a1a,  // Hunter Orange
  turbo: 0xffe44d,     // Bolt Yellow
  shield: 0x5c7cff,    // Aegis Indigo
  overdrive: 0xff44dd, // reserved magenta
  mines: 0x9a9aa6,     // Graphite trim (body is dark, red dot is the signal)
};
const COLORS = PICKUP_COLORS;

function buildPickupMesh(type: PickupType): THREE.Group {
  const g = new THREE.Group();
  const color = COLORS[type];
  const mat = new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 0.9, roughness: 0.3,
  });
  let core: THREE.Object3D;
  if (type === 'health') {
    core = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.3, 0.3), mat);
    (core as THREE.Mesh).add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.9, 0.3), mat));
  } else if (type === 'missiles') {
    // tactical rocket: pointed nose, sleek body, four swept fins, thruster flame
    const rocket = new THREE.Group();
    const hullMat = new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.3, metalness: 0.65 });
    const noseMat = new THREE.MeshStandardMaterial({
      color: 0xff6a1a, emissive: 0xff4400, emissiveIntensity: 0.7, roughness: 0.35, metalness: 0.3,
    });
    const finMat = new THREE.MeshStandardMaterial({ color: 0x22202a, roughness: 0.55, metalness: 0.5 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.62, 12), hullMat);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.38, 12), noseMat);
    nose.position.y = 0.5;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.136, 0.136, 0.09, 12), noseMat);
    band.position.y = 0.14;
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 0.09, 12), finMat);
    nozzle.position.y = -0.35;
    rocket.add(body, nose, band, nozzle);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.3, 0.19), finMat);
      fin.position.set(Math.cos(a) * 0.17, -0.24, Math.sin(a) * 0.17);
      fin.rotation.y = -a;
      fin.rotation.z = Math.cos(a) * -0.16;   // swept rake
      fin.rotation.x = Math.sin(a) * 0.16;
      rocket.add(fin);
    }
    // thruster plume: white-hot core inside an orange sheath
    const plumeOuter = new THREE.Mesh(
      new THREE.ConeGeometry(0.1, 0.34, 10),
      new THREE.MeshBasicMaterial({ color: 0xff8830, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    plumeOuter.rotation.x = Math.PI;
    plumeOuter.position.y = -0.58;
    const plumeInner = new THREE.Mesh(
      new THREE.ConeGeometry(0.05, 0.22, 8),
      new THREE.MeshBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    plumeInner.rotation.x = Math.PI;
    plumeInner.position.y = -0.52;
    rocket.add(plumeOuter, plumeInner);
    rocket.rotation.z = -0.55;   // dynamic launch-angle pose (the spin sells it)
    core = rocket;
  } else if (type === 'turbo') {
    // thunderbolt
    const bolt = new THREE.Shape();
    bolt.moveTo(0.05, 0.55);
    bolt.lineTo(-0.32, -0.02);
    bolt.lineTo(-0.05, -0.02);
    bolt.lineTo(-0.18, -0.55);
    bolt.lineTo(0.3, 0.08);
    bolt.lineTo(0.02, 0.08);
    bolt.closePath();
    core = new THREE.Mesh(
      new THREE.ExtrudeGeometry(bolt, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 1 }),
      mat,
    );
    core.position.y = 0.1;
  } else if (type === 'shield') {
    // unmistakable: a glowing bubble, same look as the on-car shield effect
    core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 0), mat);
    const bubble = new THREE.Mesh(
      new THREE.SphereGeometry(0.85, 16, 12),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.3,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    core.add(bubble);
  } else if (type === 'overdrive') {
    core = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.7, 4), mat);
    const inv = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.7, 4), mat);
    inv.rotation.x = Math.PI;
    inv.position.y = -0.55;
    core.add(inv);
    core.position.y = 0.28;
  } else {
    // mines: same look as a deployed mine — graphite disc, red dot signal
    core = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.5, 0.3, 10),
      new THREE.MeshStandardMaterial({ color: 0x2a2a32, roughness: 0.6, metalness: 0.4 }),
    );
    const bump = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xff2e2e, emissive: 0xff2200, emissiveIntensity: 1.4 }),
    );
    bump.position.y = 0.2;
    core.add(bump);
  }
  g.add(core);
  return g;
}

export class PickupManager {
  private pickups: Pickup[] = [];
  private time = 0;

  constructor(scene: THREE.Scene, points: { pos: THREE.Vector3; type: PickupType; alts?: THREE.Vector3[] }[]) {
    for (const p of points) {
      const mesh = buildPickupMesh(p.type);
      mesh.position.copy(p.pos);
      scene.add(mesh);
      // socket ring stays on the ground even while the pickup is collected —
      // it teaches spawn locations and telegraphs the respawn
      const ringMat = new THREE.MeshBasicMaterial({
        color: PICKUP_COLORS[p.type], transparent: true, opacity: 0.4, side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.1, 24), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.pos.x, p.pos.y - 0.75, p.pos.z);
      scene.add(ring);
      this.pickups.push({
        type: p.type, pos: p.pos.clone(), alts: p.alts,
        mesh, ring, ringMat, active: true, timer: 0, shrinkT: 0, popT: 0,
      });
    }
  }

  update(dt: number, vehicles: Vehicle[], onCollect: (v: Vehicle, type: PickupType) => void) {
    this.time += dt;
    for (const p of this.pickups) {
      // acquire implosion (90ms scale-down)
      if (p.shrinkT > 0) {
        p.shrinkT -= dt;
        const s = Math.max(0.01, p.shrinkT / 0.09);
        p.mesh.scale.setScalar(s);
        if (p.shrinkT <= 0) {
          p.mesh.visible = false;
          p.mesh.scale.setScalar(1);
        }
      }
      if (!p.active) {
        p.timer -= dt;
        // socket ring brightens as respawn approaches
        p.ringMat.opacity = 0.08 + 0.25 * (1 - Math.min(1, p.timer / RESPAWN_TIME[p.type]));
        if (p.timer <= 0) {
          // anti-spawn-camping: hold while anyone lingers on the socket
          let camped = false;
          for (const v of vehicles) {
            if (v.alive && v.position.distanceToSquared(p.pos) < HOLD_RADIUS * HOLD_RADIUS) { camped = true; break; }
          }
          if (camped) continue;
          // roaming pickups relocate on each respawn
          if (p.alts && p.alts.length > 1) {
            const next = p.alts[Math.floor(Math.random() * p.alts.length)];
            p.pos.copy(next);
            p.mesh.position.copy(next);
            p.ring.position.set(next.x, next.y - 0.75, next.z);
          }
          p.active = true;
          p.mesh.visible = true;
          p.popT = 0.15;
          p.ringMat.opacity = 0.4;
        }
        continue;
      }
      // respawn pop-in
      if (p.popT > 0) {
        p.popT -= dt;
        p.mesh.scale.setScalar(Math.min(1, 1 - p.popT / 0.15));
      }
      p.mesh.rotation.y += dt * 2.2;
      p.mesh.position.y = p.pos.y + Math.sin(this.time * 2.4 + p.pos.x) * 0.15;

      for (const v of vehicles) {
        if (!v.alive) continue;
        if (v.position.distanceToSquared(p.mesh.position) < 2.4 * 2.4) {
          // don't waste full pickups — a full rack (3) leaves the missiles for others
          if (p.type === 'health' && v.health >= v.spec.maxHealth) continue;
          if (p.type === 'missiles' && v.missiles >= 3) continue;
          if (p.type === 'turbo' && v.turboMeter >= v.spec.turboMax - 0.1) continue;
          if (p.type === 'mines' && v.minesAmmo >= 6) continue;
          p.active = false;
          // ±30% jitter so respawn timers can't be memorized and camped
          p.timer = RESPAWN_TIME[p.type] * (0.7 + Math.random() * 0.6);
          p.shrinkT = 0.09; // implode instead of vanishing
          onCollect(v, p.type);
          break;
        }
      }
    }
  }

  nearestActive(type: PickupType, from: THREE.Vector3): THREE.Vector3 | null {
    let best: Pickup | null = null;
    let bestD = Infinity;
    for (const p of this.pickups) {
      if (!p.active || p.type !== type) continue;
      const d = p.pos.distanceToSquared(from);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best ? best.pos.clone() : null;
  }
}
