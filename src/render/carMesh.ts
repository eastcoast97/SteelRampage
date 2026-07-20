import * as THREE from 'three';
import type { CarSpec } from '../game/specs';
import { getCarModel, getTintedTexture } from './carModels';

/** models whose stock paint IS their identity (police livery, ambulance, taxi) */
const KEEP_STOCK_PAINT = new Set<CarSpec['build']>(['suv', 'ambulance', 'taxi']);

let aoTexture: THREE.CanvasTexture | null = null;
let carScratchMap: THREE.CanvasTexture | null = null;

/** shared brushed-metal + scratch roughness map — gives car paint a rigid,
 *  gritty metal read instead of flat plastic color */
function getCarScratchMap(): THREE.CanvasTexture {
  if (carScratchMap) return carScratchMap;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6a6a6a'; g.fillRect(0, 0, 256, 256);       // mid roughness base
  // fine horizontal brushing
  for (let y = 0; y < 256; y++) {
    g.fillStyle = `rgba(${120 + Math.random() * 60},${120 + Math.random() * 60},${120 + Math.random() * 60},0.06)`;
    g.fillRect(0, y, 256, 1);
  }
  // scattered scratches / scuffs (glossier streaks)
  for (let i = 0; i < 90; i++) {
    g.strokeStyle = `rgba(${180 + Math.random() * 60},${180 + Math.random() * 60},200,${0.15 + Math.random() * 0.3})`;
    g.lineWidth = 0.6 + Math.random() * 1.2;
    g.beginPath();
    const x = Math.random() * 256, y = Math.random() * 256, a = Math.random() * Math.PI, len = 6 + Math.random() * 34;
    g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    g.stroke();
  }
  carScratchMap = new THREE.CanvasTexture(c);
  carScratchMap.wrapS = carScratchMap.wrapT = THREE.RepeatWrapping;
  carScratchMap.repeat.set(2, 2);
  return carScratchMap;
}

/** soft round ambient-occlusion contact shadow; game.ts owns placement so it
 *  can project to the ground and fade with altitude */
export function makeContactShadow(sx: number, sz: number): THREE.Mesh {
  if (!aoTexture) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 8, 64, 64, 62);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
    grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.38)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    aoTexture = new THREE.CanvasTexture(c);
  }
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(sx * 3.0, sz * 2.9),
    // material NOT shared — opacity animates per vehicle with altitude
    new THREE.MeshBasicMaterial({ map: aoTexture, transparent: true, depthWrite: false }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.renderOrder = 1;
  return blob;
}

/** Procedural cars built from beveled extruded side-profiles — real hood
 *  lines, windshield rake and rooflines instead of stacked boxes. */

type Pt = [number, number]; // [lengthwise: + = front, height from chassis bottom]

function extrudeProfile(pts: Pt[], width: number, mat: THREE.Material, bevel = 0.06): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    steps: 1,
  });
  geo.rotateY(Math.PI / 2);          // profile length → world -Z (car forward)
  geo.translate(-width / 2, 0, 0);   // center the width
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
}

/** build from a real GLB model (Kenney Car Kit) + our combat gear on top */
function buildFromModel(spec: CarSpec, model: { body: THREE.Group; wheel: THREE.Object3D }): { group: THREE.Group; wheels: THREE.Object3D[] } {
  const group = new THREE.Group();
  const { x: sx, y: sy, z: sz } = spec.size;

  const darkMat = new THREE.MeshStandardMaterial({ color: 0x17151d, roughness: 0.85 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x8f8a80, roughness: 0.3, metalness: 0.85 });

  // --- body: scale to the physics footprint, sit on the ground line ---
  const body = model.body.clone(true);
  // per-vehicle paint job + rigid brushed-metal surface treatment
  const tinted = KEEP_STOCK_PAINT.has(spec.build) ? null : getTintedTexture(spec.color);
  const scratch = getCarScratchMap();
  body.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const m = (mesh.material as THREE.MeshStandardMaterial).clone();
    if (tinted) m.map = tinted;
    // gritty, physically rigid metal read: scratch roughness + higher metalness
    m.roughnessMap = scratch;
    m.roughness = 0.62;
    m.metalness = 0.55;
    mesh.material = m;
  });
  let bbox = new THREE.Box3().setFromObject(body);
  const rawLen = bbox.max.z - bbox.min.z;
  const s = (sz * 2 + 0.35) / rawLen;
  body.scale.setScalar(s);
  bbox = new THREE.Box3().setFromObject(body);
  const center = bbox.getCenter(new THREE.Vector3());
  body.position.x -= center.x;
  body.position.z -= center.z;
  body.position.y += (-sy - 0.18) - bbox.min.y;
  group.add(body);
  bbox = new THREE.Box3().setFromObject(body);
  const roofY = bbox.max.y;
  const hoodY = bbox.min.y + (bbox.max.y - bbox.min.y) * 0.62;

  // --- roof-mounted machine gun (every car has one — it's the default weapon) ---
  const gunZ = sz * 0.18;
  const gunBase = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.26, 0.38), darkMat);
  gunBase.position.set(0, roofY + 0.1, gunZ);
  gunBase.castShadow = true;
  group.add(gunBase);
  for (const off of [-0.07, 0.07]) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, sz * 0.95, 6), steelMat);
    b.rotation.x = Math.PI / 2;
    b.position.set(off, roofY + 0.2, gunZ - sz * 0.48);
    group.add(b);
  }

  // --- per-archetype combat gear ---
  if (spec.build === 'muscle') {
    for (const side of [-1, 1]) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.26, 0.9), darkMat);
      pod.position.set(side * sx * 0.5, hoodY + 0.05, -sz * 0.5);
      pod.castShadow = true;
      group.add(pod);
      for (const off of [-0.06, 0.06]) {
        const mg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.3, 6), steelMat);
        mg.rotation.x = Math.PI / 2;
        mg.position.set(side * sx * 0.5 + off, hoodY + 0.1, -sz * 0.9);
        group.add(mg);
      }
    }
  } else if (spec.build === 'sports') {
    for (const side of [-1, 1]) {
      const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.9, 6), darkMat);
      gun.rotation.x = Math.PI / 2;
      gun.position.set(side * sx * 0.55, hoodY, -sz * 0.7);
      gun.castShadow = true;
      group.add(gun);
    }
  } else if (spec.build === 'tank') {
    const plow = new THREE.Mesh(new THREE.BoxGeometry(sx * 2.4, 0.95, 0.16), steelMat);
    plow.rotation.x = -0.5;
    plow.position.set(0, -sy + 0.55, -sz - 0.15);
    plow.castShadow = true;
    group.add(plow);
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.8, 0.16), steelMat);
      wing.rotation.set(-0.5, side * 0.5, 0);
      wing.position.set(side * sx * 1.1, -sy + 0.5, -sz + 0.15);
      group.add(wing);
    }
  } else if (spec.build === 'hearse') {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 1.5), darkMat);
    rail.position.set(0, roofY + 0.06, sz * 0.35);
    group.add(rail);
    const bomb = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), darkMat);
    bomb.position.set(0, roofY + 0.3, sz * 0.35);
    bomb.castShadow = true;
    group.add(bomb);
    const fuse = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 6, 5),
      new THREE.MeshStandardMaterial({ color: 0xff3322, emissive: 0xff2200, emissiveIntensity: 1.8 }),
    );
    fuse.position.set(0, roofY + 0.56, sz * 0.35);
    group.add(fuse);
  }

  // --- wheels from the kit, mounted on our steer/spin rig ---
  const wheels: THREE.Object3D[] = [];
  const targetR = spec.build === 'tank' || spec.build === 'suv' ? 0.32 : 0.27;
  const wbox = new THREE.Box3().setFromObject(model.wheel);
  const rawR = (wbox.max.y - wbox.min.y) / 2;
  const ws = targetR / rawR;
  const anchors = [
    [-sx * 0.85, -sy, -sz * 0.72],
    [sx * 0.85, -sy, -sz * 0.72],
    [-sx * 0.85, -sy, sz * 0.72],
    [sx * 0.85, -sy, sz * 0.72],
  ];
  anchors.forEach(([wx, wy, wz], i) => {
    const pivot = new THREE.Group();
    pivot.position.set(wx, wy, wz);
    const spinner = new THREE.Group();
    const mesh = model.wheel.clone(true);
    mesh.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    // center the wheel model on its own origin
    const wc = wbox.getCenter(new THREE.Vector3());
    mesh.position.set(-wc.x * ws, -wc.y * ws, -wc.z * ws);
    mesh.scale.setScalar(ws);
    const isRight = i % 2 === 1;
    if (isRight) mesh.scale.x *= -1; // mirror for the right side
    spinner.add(mesh);
    pivot.add(spinner);
    group.add(pivot);
    wheels.push(pivot);
  });

  return { group, wheels };
}

export function buildCarMesh(spec: CarSpec, colorOverride?: number): { group: THREE.Group; wheels: THREE.Object3D[] } {
  const model = getCarModel(spec.build);
  if (model) return buildFromModel(spec, model);

  const group = new THREE.Group();
  const color = colorOverride ?? spec.color;
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.34, metalness: 0.5 });
  const bodyDark = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).multiplyScalar(0.5), roughness: 0.55, metalness: 0.4,
  });
  const accentMat = new THREE.MeshStandardMaterial({ color: spec.accent, roughness: 0.5, metalness: 0.3 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x17151d, roughness: 0.85 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x8f8a80, roughness: 0.3, metalness: 0.85 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x6fb6dd, roughness: 0.1, metalness: 0.7 });
  const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff2b8, emissive: 0xffd25e, emissiveIntensity: 2.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xff3020, emissive: 0xcc1500, emissiveIntensity: 1.8 });

  const { x: sx, y: sy, z: sz } = spec.size;
  const W = sx * 2 * 0.92;
  const baseY = -sy; // profile y=0 sits at chassis bottom

  const addProfile = (pts: Pt[], width: number, mat: THREE.Material, bevel?: number) => {
    const m = extrudeProfile(pts, width, mat, bevel);
    m.position.y = baseY;
    group.add(m);
    return m;
  };

  const box = (
    mat: THREE.Material, w: number, h: number, d: number,
    x: number, y: number, z: number, rx = 0, ry = 0, rz = 0,
  ) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    group.add(m);
    return m;
  };
  const cyl = (mat: THREE.Material, r: number, len: number, x: number, y: number, z: number, alongZ = true, segs = 8) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, segs), mat);
    if (alongZ) m.rotation.x = Math.PI / 2;
    m.position.set(x, y, z);
    m.castShadow = true;
    group.add(m);
    return m;
  };

  if (spec.build === 'speed') {
    // ---- VIPER: razor wedge ----
    addProfile([
      [1.95, 0.05], [1.92, 0.3], [0.9, 0.46], [0.45, 0.5],
      [0.02, 0.86], [-0.78, 0.9], [-1.32, 0.6], [-1.9, 0.64], [-1.95, 0.34], [-1.95, 0.05],
    ], W, bodyMat);
    addProfile([
      [0.42, 0.52], [0.0, 0.84], [-0.74, 0.87], [-1.15, 0.6], [-0.2, 0.54],
    ], W * 0.72, glassMat, 0.03);
    box(accentMat, W * 1.15, sy * 0.28, 0.34, 0, baseY + 1.15, sz * 0.92);      // wing
    box(accentMat, 0.16, 0.55, 0.16, -W * 0.42, baseY + 0.82, sz * 0.92);
    box(accentMat, 0.16, 0.55, 0.16, W * 0.42, baseY + 0.82, sz * 0.92);
    box(accentMat, 0.16, 0.42, sz * 1.5, 0, baseY + 0.62, -sz * 0.15);          // dorsal stripe
    cyl(steelMat, 0.08, 0.4, -W * 0.25, baseY + 0.22, sz + 0.1);                 // exhausts
    cyl(steelMat, 0.08, 0.4, W * 0.25, baseY + 0.22, sz + 0.1);
  } else if (spec.build === 'muscle') {
    // ---- HELLCAT: brutal muscle coupe ----
    addProfile([
      [2.0, 0.08], [1.96, 0.5], [1.82, 0.62], [0.55, 0.68],
      [0.12, 1.12], [-0.85, 1.16], [-1.32, 0.78], [-1.92, 0.84], [-2.0, 0.5], [-2.0, 0.08],
    ], W, bodyMat);
    addProfile([
      [0.5, 0.7], [0.1, 1.08], [-0.8, 1.12], [-1.24, 0.78], [-0.3, 0.72],
    ], W * 0.8, glassMat, 0.03);
    box(darkMat, W * 0.3, 0.22, 0.5, 0, baseY + 0.78, -sz * 0.55);              // hood scoop
    box(darkMat, W * 0.95, 0.32, 0.1, 0, baseY + 0.28, -sz - 0.04);             // grille
    cyl(steelMat, 0.1, sz * 1.1, -W * 0.55, baseY + 0.16, sz * 0.1);            // side pipes
    cyl(steelMat, 0.1, sz * 1.1, W * 0.55, baseY + 0.16, sz * 0.1);
    // hood minigun pods
    for (const side of [-1, 1]) {
      box(darkMat, 0.34, 0.3, 1.0, side * W * 0.28, baseY + 0.85, -sz * 0.5);
      for (const off of [-0.07, 0.07]) {
        const mg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.5, 6), steelMat);
        mg.rotation.x = Math.PI / 2;
        mg.position.set(side * W * 0.28 + off, baseY + 0.9, -sz * 0.92);
        mg.castShadow = true;
        group.add(mg);
      }
    }
  } else if (spec.build === 'sports') {
    // ---- SCORCH: cab-forward exotic ----
    addProfile([
      [2.05, 0.05], [2.0, 0.3], [1.15, 0.44], [0.55, 0.5],
      [-0.05, 0.84], [-0.95, 0.88], [-1.5, 0.64], [-2.0, 0.68], [-2.05, 0.4], [-2.05, 0.05],
    ], W, bodyMat);
    addProfile([
      [0.5, 0.52], [-0.08, 0.82], [-0.88, 0.85], [-1.32, 0.62], [-0.35, 0.54],
    ], W * 0.66, glassMat, 0.03);
    box(accentMat, W * 1.12, 0.12, 0.3, 0, baseY + 0.98, sz * 0.9);             // low wing
    box(darkMat, W * 0.8, 0.24, 0.12, 0, baseY + 0.16, sz + 0.03);              // diffuser
    box(accentMat, 0.5, 0.1, 1.1, -W * 0.38, baseY + 0.52, -sz * 0.42);         // fender vents
    box(accentMat, 0.5, 0.1, 1.1, W * 0.38, baseY + 0.52, -sz * 0.42);
    for (const side of [-1, 1]) {                                                // flame guns
      const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 1.0, 6), darkMat);
      gun.rotation.x = Math.PI / 2;
      gun.position.set(side * W * 0.42, baseY + 0.62, -sz * 0.75);
      gun.castShadow = true;
      group.add(gun);
    }
  } else if (spec.build === 'suv') {
    // ---- RAMPART: riot SUV ----
    addProfile([
      [2.1, 0.1], [2.06, 0.6], [1.88, 0.74], [1.05, 0.8],
      [0.8, 1.52], [-1.72, 1.58], [-2.02, 1.0], [-2.1, 0.66], [-2.1, 0.1],
    ], W, bodyMat);
    // side glass band
    box(glassMat, W + 0.06, 0.4, sz * 1.15, 0, baseY + 1.22, sz * 0.2);
    box(accentMat, W + 0.08, 0.42, sz * 0.95, 0, baseY + 0.45, -sz * 0.1);      // white door band
    box(steelMat, W * 1.12, 0.55, 0.14, 0, baseY + 0.35, -sz - 0.06, -0.3);     // push bar
    box(darkMat, W * 0.85, 0.12, sz * 1.1, 0, baseY + 1.68, sz * 0.15);         // roof rack
    // police light bar
    const redLight = new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff0000, emissiveIntensity: 2.4 });
    const blueLight = new THREE.MeshStandardMaterial({ color: 0x3355ff, emissive: 0x0022ff, emissiveIntensity: 2.4 });
    box(redLight, W * 0.32, 0.14, 0.26, -W * 0.19, baseY + 1.78, -sz * 0.25);
    box(blueLight, W * 0.32, 0.14, 0.26, W * 0.19, baseY + 1.78, -sz * 0.25);
  } else if (spec.build === 'tank') {
    // ---- JUGGERNAUT: armored rig ----
    addProfile([
      [2.25, 0.12], [2.2, 0.85], [2.0, 1.02], [1.32, 1.08],
      [1.05, 1.92], [0.15, 1.98], [-0.05, 1.3], [-2.15, 1.36], [-2.25, 0.85], [-2.25, 0.12],
    ], W, bodyMat);
    box(glassMat, W * 0.8, 0.42, 0.1, 0, baseY + 1.62, -sz * 0.52, -0.28);      // cab glass
    box(bodyDark, W * 0.96, 0.5, sz * 0.9, 0, baseY + 1.55, sz * 0.52);         // bed armor
    box(accentMat, W + 0.1, 0.2, sz * 1.9, 0, baseY + 0.95, 0);                 // armor belt
    // plow
    box(steelMat, W * 1.2, 0.95, 0.16, 0, baseY + 0.5, -sz - 0.1, -0.5);
    box(steelMat, 0.7, 0.8, 0.16, -W * 0.6, baseY + 0.45, -sz + 0.1, -0.5, 0.5);
    box(steelMat, 0.7, 0.8, 0.16, W * 0.6, baseY + 0.45, -sz + 0.1, -0.5, -0.5);
    cyl(darkMat, 0.13, 1.5, -W * 0.36, baseY + 2.4, -sz * 0.35, false);         // stacks
    cyl(darkMat, 0.13, 1.5, W * 0.36, baseY + 2.4, -sz * 0.35, false);
  } else {
    // ---- MORTIS: the hearse ----
    addProfile([
      [2.35, 0.08], [2.3, 0.55], [2.12, 0.68], [1.12, 0.74],
      [0.82, 1.3], [-2.02, 1.36], [-2.28, 0.88], [-2.35, 0.56], [-2.35, 0.08],
    ], W, bodyMat);
    box(glassMat, W + 0.05, 0.34, 0.55, 0, baseY + 1.02, -sz * 0.52, -0.24);    // windshield
    box(accentMat, W + 0.06, 0.34, sz * 1.05, 0, baseY + 1.0, sz * 0.35);       // purple window band
    box(steelMat, W * 0.85, 0.26, 0.1, 0, baseY + 0.3, -sz - 0.04);             // chrome grille
    box(accentMat, 0.2, 0.5, 0.32, -W * 0.42, baseY + 0.75, sz * 0.98);         // tail fins
    box(accentMat, 0.2, 0.5, 0.32, W * 0.42, baseY + 0.75, sz * 0.98);
    // roof bomb rail + spare bomb
    box(darkMat, 0.5, 0.12, 1.6, 0, baseY + 1.46, sz * 0.35);
    const bomb = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), darkMat);
    bomb.position.set(0, baseY + 1.72, sz * 0.35);
    bomb.castShadow = true;
    group.add(bomb);
    const fuse = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 6, 5),
      new THREE.MeshStandardMaterial({ color: 0xff3322, emissive: 0xff2200, emissiveIntensity: 1.8 }),
    );
    fuse.position.set(0, baseY + 2.0, sz * 0.35);
    group.add(fuse);
  }

  // fender flares over each wheel
  for (const [wx, wz] of [[-sx * 0.85, -sz * 0.72], [sx * 0.85, -sz * 0.72], [-sx * 0.85, sz * 0.72], [sx * 0.85, sz * 0.72]]) {
    box(bodyDark, 0.3, 0.32, 1.08, wx + (wx > 0 ? 0.12 : -0.12), baseY + 0.42, wz);
  }

  // head/tail lights
  box(lightMat, sx * 0.42, 0.16, 0.07, -sx * 0.55, baseY + 0.4, -sz - 0.05);
  box(lightMat, sx * 0.42, 0.16, 0.07, sx * 0.55, baseY + 0.4, -sz - 0.05);
  box(tailMat, sx * 0.5, 0.14, 0.07, -sx * 0.55, baseY + 0.45, sz + 0.05);
  box(tailMat, sx * 0.5, 0.14, 0.07, sx * 0.55, baseY + 0.45, sz + 0.05);

  // roof-mounted machine gun
  const gunHeights: Record<CarSpec['build'], number> = {
    speed: 0.98, muscle: 1.24, sports: 0.95, suv: 1.66, tank: 2.06, hearse: 1.44, ambulance: 1.66, taxi: 1.24,
  };
  const gunY = baseY + gunHeights[spec.build];
  const gunZ = spec.build === 'tank' ? -sz * 0.55 : sz * 0.25;
  box(darkMat, 0.4, 0.3, 0.4, 0, gunY, gunZ);
  for (const off of [-0.07, 0.07]) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, sz * 1.0, 6), steelMat);
    b.rotation.x = Math.PI / 2;
    b.position.set(off, gunY + 0.12, gunZ - sz * 0.5);
    group.add(b);
  }


  // wheels: pivot (steer) -> tire (spin)
  const wheels: THREE.Object3D[] = [];
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x121016, roughness: 0.95 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xc9c2b0, roughness: 0.3, metalness: 0.75 });
  const wheelR = spec.build === 'tank' || spec.build === 'suv' ? 0.32 : 0.27;
  const wheelW = spec.build === 'tank' ? 0.36 : 0.27;
  const anchors = [
    [-sx * 0.85, -sy, -sz * 0.72],
    [sx * 0.85, -sy, -sz * 0.72],
    [-sx * 0.85, -sy, sz * 0.72],
    [sx * 0.85, -sy, sz * 0.72],
  ];
  for (const [wx, wy, wz] of anchors) {
    const pivot = new THREE.Group();
    pivot.position.set(wx, wy, wz);
    const tire = new THREE.Group();
    const t = new THREE.Mesh(new THREE.CylinderGeometry(wheelR, wheelR, wheelW, 14), tireMat);
    t.rotation.z = Math.PI / 2;
    t.castShadow = true;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(wheelR * 0.62, wheelR * 0.62, wheelW + 0.02, 8), hubMat);
    rim.rotation.z = Math.PI / 2;
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(wheelR * 0.18, wheelR * 0.18, wheelW + 0.07, 6), darkMat);
    nut.rotation.z = Math.PI / 2;
    tire.add(t, rim, nut);
    pivot.add(tire);
    group.add(pivot);
    wheels.push(pivot);
  }

  return { group, wheels };
}
