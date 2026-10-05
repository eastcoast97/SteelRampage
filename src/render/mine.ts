import * as THREE from 'three';

/**
 * THE mine. One mesh, used everywhere a mine appears: the ground pickup, the
 * clamps on your rear bumper, and the armed mine lying in the road.
 *
 * Written for the same reason as `rocket.ts`: these were three separate meshes
 * with three different sets of dimensions (r0.42/0.5 at 10 segments for the
 * pickup and the deployed mine, r0.17/0.2 at 8 for the bumper clamp) and they
 * had started to look like different objects. Scale the result if you need it
 * smaller; do not rebuild it.
 *
 * Built axis-up (+Y), which is how it lies in the road.
 */

const shellMat = new THREE.MeshStandardMaterial({
  color: 0x2a2a32, roughness: 0.6, metalness: 0.42,
});

export interface MineResult {
  group: THREE.Group;
  /** the indicator's material — deployed mines pulse this while armed */
  glowMat: THREE.MeshStandardMaterial;
}

export function buildMine(): MineResult {
  const g = new THREE.Group();
  // its own material instance: a deployed mine animates emissiveIntensity, and
  // sharing one would make every mine in the match pulse together
  const glowMat = new THREE.MeshStandardMaterial({
    color: 0xff3322, emissive: 0xff2200, emissiveIntensity: 1.2, roughness: 0.4,
  });

  const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.26, 10), shellMat);
  const bump = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), glowMat);
  bump.position.y = 0.18;
  g.add(shell, bump);

  // three stubby prongs, so it reads as ordnance rather than a hockey puck
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const prong = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.16, 5), shellMat);
    prong.position.set(Math.cos(a) * 0.33, 0.14, Math.sin(a) * 0.33);
    prong.rotation.z = Math.cos(a) * 0.35;
    prong.rotation.x = -Math.sin(a) * 0.35;
    g.add(prong);
  }

  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return { group: g, glowMat };
}
