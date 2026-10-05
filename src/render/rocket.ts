import * as THREE from 'three';

/**
 * THE missile. One mesh, used everywhere a missile appears: the ground pickup,
 * the rack on the car, and the projectile in flight.
 *
 * These were three separately-written meshes and they had drifted into three
 * different weapons — the pickup was a white rocket with a glowing orange nose
 * and four swept fins, while the one mounted on the car was a thinner tube with
 * a dull red tip and two flat fins. Sharing the builder is the only way they
 * stay recognisably the same object as it moves from the ground, to your rack,
 * to the air.
 *
 * Built nose-up (+Y), which is how the pickup displays it; the rack rotates it
 * nose-forward.
 */

const hullMat = new THREE.MeshStandardMaterial({
  color: 0xe8e4dc, roughness: 0.3, metalness: 0.65,
});
const noseMat = new THREE.MeshStandardMaterial({
  color: 0xff6a1a, emissive: 0xff4400, emissiveIntensity: 0.7, roughness: 0.35, metalness: 0.3,
});
const finMat = new THREE.MeshStandardMaterial({
  color: 0x22202a, roughness: 0.55, metalness: 0.5,
});

export interface RocketOpts {
  /** additive thruster cone — on for the pickup display and in flight, off on the rack */
  plume?: boolean;
}

export function buildRocket(opts: RocketOpts = {}): THREE.Group {
  const g = new THREE.Group();

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.62, 12), hullMat);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.38, 12), noseMat);
  nose.position.y = 0.5;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.136, 0.136, 0.09, 12), noseMat);
  band.position.y = 0.14;
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 0.09, 12), finMat);
  nozzle.position.y = -0.35;
  g.add(body, nose, band, nozzle);

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.3, 0.19), finMat);
    fin.position.set(Math.cos(a) * 0.17, -0.24, Math.sin(a) * 0.17);
    fin.rotation.y = -a;
    fin.rotation.z = Math.cos(a) * -0.16;   // swept rake
    fin.rotation.x = Math.sin(a) * 0.16;
    g.add(fin);
  }

  if (opts.plume) {
    // white-hot core inside an orange sheath
    const outer = new THREE.Mesh(
      new THREE.ConeGeometry(0.1, 0.34, 10),
      new THREE.MeshBasicMaterial({
        color: 0xff8830, transparent: true, opacity: 0.75,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    outer.rotation.x = Math.PI;
    outer.position.y = -0.58;
    const inner = new THREE.Mesh(
      new THREE.ConeGeometry(0.05, 0.22, 8),
      new THREE.MeshBasicMaterial({
        color: 0xfff2c0, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    inner.rotation.x = Math.PI;
    inner.position.y = -0.52;
    g.add(outer, inner);
  }

  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return g;
}
