import * as THREE from 'three';

/**
 * THE nuke. One mesh, used everywhere it appears: the ground pickup, the single
 * warhead strapped to your rear deck, and the bomb in flight.
 *
 * Built once for the same reason as `rocket.ts` and `mine.ts` — anything that
 * shows up in more than one place in this game drifts into several different
 * objects if it is written out more than once.
 *
 * Deliberately fat and stubby next to the missile (0.26 radius against 0.13):
 * the silhouette has to say "that is a different weight class" from across the
 * arena, before the hazard stripes are legible.
 *
 * Built nose-up (+Y), which is how the pickup displays it; the rack and the
 * projectile rotate it nose-forward.
 */

const caseMat = new THREE.MeshStandardMaterial({
  color: 0x2b2d26, roughness: 0.52, metalness: 0.6,
});
const bandMat = new THREE.MeshStandardMaterial({
  color: 0xaaff00, emissive: 0x88dd00, emissiveIntensity: 0.9, roughness: 0.4, metalness: 0.2,
});
const finMat = new THREE.MeshStandardMaterial({
  color: 0x4a4d42, roughness: 0.6, metalness: 0.55,
});

export interface NukeOpts {
  /** additive thruster cone — on for the pickup display and in flight, off on the rack */
  plume?: boolean;
}

export function buildNuke(opts: NukeOpts = {}): THREE.Group {
  const g = new THREE.Group();

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.74, 16), caseMat);
  // blunt ogive, not a point — a nuke is a fat bomb, not a dart
  const nose = new THREE.Mesh(
    new THREE.SphereGeometry(0.26, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), caseMat);
  nose.position.y = 0.37;
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.26, 0.16, 16), caseMat);
  tail.position.y = -0.45;
  g.add(body, nose, tail);

  // hazard banding — the only lit part, so it reads at night and under bloom
  for (const y of [0.24, 0.02, -0.2]) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.268, 0.268, 0.07, 16), bandMat);
    band.position.y = y;
    g.add(band);
  }

  // four big square fins plus the tail ring: unmistakably a bomb in silhouette
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.3, 0.3), finMat);
    fin.position.set(Math.cos(a) * 0.3, -0.42, Math.sin(a) * 0.3);
    fin.rotation.y = -a;
    g.add(fin);
  }
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.035, 6, 18), finMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.54;
  g.add(ring);

  if (opts.plume) {
    const outer = new THREE.Mesh(
      new THREE.ConeGeometry(0.17, 0.5, 12),
      new THREE.MeshBasicMaterial({
        color: 0xbaff4a, transparent: true, opacity: 0.6,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    outer.rotation.x = Math.PI;
    outer.position.y = -0.82;
    const inner = new THREE.Mesh(
      new THREE.ConeGeometry(0.08, 0.3, 8),
      new THREE.MeshBasicMaterial({
        color: 0xf2ffd8, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    inner.rotation.x = Math.PI;
    inner.position.y = -0.73;
    g.add(outer, inner);
  }

  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return g;
}
