import * as THREE from 'three';
import type { CarSpec } from '../game/specs';
import { getCarModel, getTintedTexture, getWeatheredStockTexture } from './carModels';

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
    // Kenney kit models are UV-mapped to a shared palette → retint that map.
    // Custom Blender models have no map → just set the paint colour directly.
    // Every palette gets the battle-wear pass (grime/rust/chips).
    if (m.map) {
      m.map = tinted ?? getWeatheredStockTexture() ?? m.map;
    } else {
      m.color = new THREE.Color(spec.color);
    }
    // gritty, physically rigid metal read: scratch roughness + higher metalness
    // + strong env reflections (the scene environment map is what sells car paint)
    m.roughnessMap = scratch;
    m.roughness = 0.5;
    m.metalness = 0.6;
    m.envMapIntensity = 1.5;
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

  // ================= WEAPONIZATION KIT (Twisted-Metal-style) =================
  const gunMetal = new THREE.MeshStandardMaterial({ color: 0x23212a, roughness: 0.55, metalness: 0.7 });
  const rustMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.9, metalness: 0.25 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffe9b8, emissive: 0xffc866, emissiveIntensity: 1.6 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x7a0f0f, emissive: 0xff1a10, emissiveIntensity: 1.1, roughness: 0.35 });

  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };
  const tube = (r: number, len: number, m: THREE.Material, x: number, y: number, z: number, alongZ = true, seg = 8) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), m);
    if (alongZ) mesh.rotation.x = Math.PI / 2;
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };

  // --- roof MG: armored housing + twin barrels with muzzle brakes + ammo box ---
  const gunZ = sz * 0.18;
  box(0.46, 0.3, 0.5, gunMetal, 0, roofY + 0.12, gunZ);
  box(0.3, 0.1, 0.34, darkMat, 0, roofY + 0.32, gunZ);                       // sight block
  box(0.34, 0.22, 0.26, rustMat, 0.28, roofY + 0.1, gunZ + 0.1);            // ammo box
  for (const off of [-0.08, 0.08]) {
    tube(0.045, sz * 0.95, steelMat, off, roofY + 0.2, gunZ - sz * 0.48);
    tube(0.07, 0.14, gunMetal, off, roofY + 0.2, gunZ - sz * 0.95);         // muzzle brake
  }

  // --- universal detailing: whip antennas, taillight strip, plate, skirts ---
  tube(0.015, 0.9, darkMat, -sx * 0.7, roofY + 0.35, sz * 0.82, false, 5);
  tube(0.015, 0.62, darkMat, sx * 0.74, roofY + 0.22, sz * 0.85, false, 5);
  for (const side of [-1, 1]) {
    box(sx * 0.52, 0.09, 0.05, tailMat, side * sx * 0.42, hoodY - 0.05, sz + 0.16);   // taillight strips
  }
  box(0.36, 0.15, 0.03, new THREE.MeshStandardMaterial({ color: 0xd8d4c4, roughness: 0.6 }),
    0, hoodY - 0.18, sz + 0.17);                                                       // license plate
  for (const side of [-1, 1]) {
    box(0.1, 0.18, sz * 1.15, darkMat, side * (sx * 0.98), -sy + 0.1, 0);              // side armor skirts
  }

  // --- shared builders ---
  const gatling = (x: number, y: number, z: number, s = 1) => {
    box(0.5 * s, 0.16, 0.5 * s, gunMetal, x, y, z);                    // base ring
    box(0.3 * s, 0.3, 0.36 * s, darkMat, x, y + 0.2, z);               // pivot block
    const drum = tube(0.13 * s, 0.5, gunMetal, x, y + 0.28, z - 0.4 * s);
    drum.castShadow = true;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      tube(0.032, 0.9, steelMat, x + Math.cos(a) * 0.08 * s, y + 0.28 + Math.sin(a) * 0.08 * s, z - 0.9 * s, true, 6);
    }
    box(0.24 * s, 0.2, 0.3 * s, rustMat, x + 0.3 * s, y + 0.1, z + 0.14);   // side ammo drum
  };
  const lightRack = (y: number, z: number, w: number, colors = [0xffe9b8, 0xffe9b8, 0xffe9b8, 0xffe9b8]) => {
    box(w, 0.09, 0.1, darkMat, 0, y, z);
    colors.forEach((c, i) => {
      const lm = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1.6 });
      box(0.14, 0.12, 0.12, lm, -w / 2 + 0.12 + (i * (w - 0.24)) / (colors.length - 1), y + 0.1, z);
    });
  };
  const windowBars = (z: number, w: number, yLo: number, yHi: number, tilt = 0) => {
    const n = 4;
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + (i * w) / (n - 1);
      box(0.045, yHi - yLo, 0.045, darkMat, x, (yLo + yHi) / 2, z, tilt, 0, 0);
    }
    box(w + 0.1, 0.05, 0.05, darkMat, 0, yHi, z, tilt, 0, 0);
  };
  const exhaustStacks = () => {
    for (const side of [-1, 1]) {
      tube(0.075, sy * 1.6, steelMat, side * sx * 0.78, roofY - 0.35, sz * 0.55, false, 8);
      tube(0.09, 0.16, darkMat, side * sx * 0.78, roofY + 0.45, sz * 0.55, false, 8);
    }
  };
  const plowBlade = (bigger = false) => {
    const w = sx * (bigger ? 2.5 : 2.1), h = bigger ? 1.0 : 0.6;
    const blade = box(w, h, 0.14, steelMat, 0, -sy + h * 0.55, -sz - 0.16, -0.48);
    blade.castShadow = true;
    for (let i = 0; i < 5; i++) {                                        // vertical ribs
      box(0.07, h * 0.95, 0.06, rustMat, -w / 2 + 0.2 + (i * (w - 0.4)) / 4, -sy + h * 0.55, -sz - 0.24, -0.48);
    }
    for (const side of [-1, 1]) {                                        // angled wings
      box(0.6, h * 0.85, 0.12, steelMat, side * (w / 2 + 0.22), -sy + h * 0.5, -sz + 0.08, -0.48, side * 0.55);
    }
  };

  // --- per-archetype loadouts ---
  if (spec.build === 'muscle') {
    for (const side of [-1, 1]) {                                        // hood minigun pods
      box(0.32, 0.28, 0.95, gunMetal, side * sx * 0.5, hoodY + 0.05, -sz * 0.5);
      for (const off of [-0.06, 0.06]) {
        tube(0.045, 1.3, steelMat, side * sx * 0.5 + off, hoodY + 0.1, -sz * 0.9);
        tube(0.065, 0.12, gunMetal, side * sx * 0.5 + off, hoodY + 0.1, -sz * 1.28);
      }
    }
    windowBars(sz * 0.62, sx * 1.1, hoodY + 0.05, roofY - 0.05, 0.35);   // rear glass armor
    box(sx * 1.5, 0.1, 0.34, darkMat, 0, roofY + 0.02, sz * 0.55);      // trunk spoiler
  } else if (spec.build === 'speed') {
    box(sx * 1.7, 0.28, 0.09, steelMat, 0, -sy + 0.4, -sz - 0.12, -0.3); // low bull bar
    for (const side of [-1, 1]) tube(0.06, 0.8, gunMetal, side * sx * 0.55, hoodY, -sz * 0.72);
  } else if (spec.build === 'sports') {
    for (const side of [-1, 1]) {                                        // flame tanks + nozzles
      const tank = tube(0.16, 0.9, rustMat, side * sx * 0.55, roofY - 0.12, sz * 0.5, true, 10);
      tank.rotation.z = side * 0.12;
      tube(0.05, 0.5, gunMetal, side * sx * 0.5, hoodY + 0.02, -sz * 0.8);
      tube(0.075, 0.1, darkMat, side * sx * 0.5, hoodY + 0.02, -sz * 1.03);
    }
  } else if (spec.build === 'suv') {
    gatling(0, roofY + 0.08, -sz * 0.05, 1.1);                           // RAMPART auto-turret
    lightRack(roofY + 0.16, sz * 0.55, sx * 1.3, [0xff3030, 0xffe9b8, 0xffe9b8, 0x3060ff]);
    plowBlade(false);
  } else if (spec.build === 'tank') {
    plowBlade(true);
    exhaustStacks();
    windowBars(-sz * 0.42, sx * 1.2, hoodY + 0.15, roofY - 0.02, -0.25); // windshield cage
    lightRack(roofY + 0.12, -sz * 0.32, sx * 1.4);
  } else if (spec.build === 'hearse') {
    box(0.5, 0.1, 1.5, darkMat, 0, roofY + 0.06, sz * 0.35);            // bomb cradle
    const bomb = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), gunMetal);
    bomb.position.set(0, roofY + 0.3, sz * 0.35);
    bomb.castShadow = true;
    group.add(bomb);
    const fuse = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 6, 5),
      new THREE.MeshStandardMaterial({ color: 0xff3322, emissive: 0xff2200, emissiveIntensity: 1.8 }),
    );
    fuse.position.set(0, roofY + 0.56, sz * 0.35);
    group.add(fuse);
    exhaustStacks();
    windowBars(sz * 0.9, sx * 1.0, hoodY - 0.05, roofY - 0.15);          // rear door bars
  } else if (spec.build === 'ambulance') {
    lightRack(roofY + 0.1, -sz * 0.25, sx * 1.35, [0xff3030, 0xffffff, 0xffffff, 0x3060ff]);
    box(sx * 1.6, 0.3, 0.1, steelMat, 0, -sy + 0.42, -sz - 0.12, -0.35); // bull bar
  } else if (spec.build === 'taxi') {
    box(0.7, 0.22, 0.34, rustMat, 0, roofY + 0.12, sz * 0.5);            // rear mine dispenser
    box(0.5, 0.1, 0.1, darkMat, 0, hoodY - 0.1, sz + 0.2);               // drop chute
  }

  // --- wheel hub spikes (the TM signature) — skip the civic-liveried builds ---
  const spikey = !['ambulance', 'taxi'].includes(spec.build);

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
    // hub spike — spins with the wheel (the Twisted Metal signature).
    // Dull alloy, NOT steelMat: a mirror cone catches the sun as a white
    // bloom flare that reads as a headlight glitch.
    const spikeMat = new THREE.MeshStandardMaterial({ color: 0x6a655c, roughness: 0.55, metalness: 0.5 });
    if (spikey) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.34, 8), spikeMat);
      spike.rotation.z = isRight ? -Math.PI / 2 : Math.PI / 2;
      spike.position.x = (isRight ? 1 : -1) * 0.2;
      spike.castShadow = true;
      spinner.add(spike);
    }
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
