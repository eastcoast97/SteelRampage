import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { PickupType } from './pickups';
import type { PedZone } from './peds';

/** "Overdrive City" — 240×240, ring highway + boulevards, anti-snag props.
 *  Scale ratios (vehicle width 2m): boulevards 18m (9×), ring 20m (10×),
 *  block alleys ≥13m (6.5×). See docs/LEVEL-DESIGN.md. */
export const ARENA_HALF = 120;

export interface ArenaData {
  spawnPoints: { pos: THREE.Vector3; yaw: number }[];
  pickupPoints: { pos: THREE.Vector3; type: PickupType; alts?: THREE.Vector3[] }[];
  barrelPoints: THREE.Vector3[];
  pedZones: PedZone[];
  /** which SKY_PRESETS entry was used — hosts share it so guests match */
  skyIdx: number;
  /** auto-turbo strips (y = surface height so pads work on elevated track) */
  boostPads: { x: number; y: number; z: number; hx: number; hz: number }[];
}

// ---------------------------------------------------------------- helpers

/** exact-collider box — for surfaces cars drive on/along (walls, tunnel, deck) */
function addBox(
  world: RAPIER.World, scene: THREE.Scene, mat: THREE.Material | THREE.Material[],
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
  yaw = 0, castShadow = true,
): void {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.6), body);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mat);
  mesh.position.set(cx, cy, cz);
  mesh.rotation.y = yaw;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

/** anti-snag prop: rounded collider at ~92% of the visual footprint so
 *  grazing hits deflect instead of stopping the car */
function addProp(
  world: RAPIER.World, scene: THREE.Scene, mat: THREE.Material | THREE.Material[],
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
  yaw = 0,
): void {
  const R = 0.35;
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }),
  );
  world.createCollider(
    RAPIER.ColliderDesc.roundCuboid(
      Math.max(0.05, hx * 0.92 - R),
      Math.max(0.05, hy - R),
      Math.max(0.05, hz * 0.92 - R),
      R,
    ).setFriction(0.4),
    body,
  );
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mat);
  mesh.position.set(cx, cy, cz);
  mesh.rotation.y = yaw;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

function addDecoBox(
  scene: THREE.Scene, mat: THREE.Material,
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number, yaw = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mat);
  mesh.position.set(cx, cy, cz);
  mesh.rotation.y = yaw;
  scene.add(mesh);
  return mesh;
}

function addRamp(
  world: RAPIER.World, scene: THREE.Scene, mat: THREE.Material,
  cx: number, cz: number, yaw: number,
  length = 12, width = 8, height = 3.2,
): void {
  const pitch = Math.atan2(height, length);
  const halfLen = Math.sqrt(length * length + height * height) / 2;
  const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -pitch);
  const q = qYaw.multiply(qPitch);
  const cy = height / 2 - 0.15;
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(width / 2, 0.3, halfLen).setFriction(0.5), body);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, 0.6, halfLen * 2), mat);
  mesh.position.set(cx, cy, cz);
  mesh.quaternion.copy(q);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// ---------------------------------------------------------------- textures

function makeGroundTexture(): THREE.CanvasTexture {
  // "roaming zone": warm worn concrete — clearly distinct from dark asphalt roads
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#5e5760';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 300; i++) {
    g.fillStyle = `rgba(${70 + Math.random() * 40}, ${62 + Math.random() * 34}, ${66 + Math.random() * 36}, 0.3)`;
    const s = 10 + Math.random() * 50;
    g.fillRect(Math.random() * 512, Math.random() * 512, s, s);
  }
  // concrete expansion joints (large grid — reads as plaza paving)
  g.strokeStyle = 'rgba(30, 26, 34, 0.3)';
  g.lineWidth = 3;
  for (let i = 0; i <= 4; i++) {
    const p = (i / 4) * 512;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 512); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(512, p); g.stroke();
  }
  g.strokeStyle = 'rgba(20, 16, 24, 0.35)';
  g.lineWidth = 1.5;
  for (let i = 0; i < 22; i++) {
    g.beginPath();
    let x = Math.random() * 512, y = Math.random() * 512;
    g.moveTo(x, y);
    for (let j = 0; j < 5; j++) { x += (Math.random() - 0.5) * 90; y += (Math.random() - 0.5) * 90; g.lineTo(x, y); }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(15, 15);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeRoadTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d')!;
  // driving zone: dark asphalt so the bright markings pop
  g.fillStyle = '#1e1c24';
  g.fillRect(0, 0, 256, 512);
  for (let i = 0; i < 240; i++) {
    g.fillStyle = `rgba(${24 + Math.random() * 22}, ${23 + Math.random() * 20}, ${29 + Math.random() * 22}, 0.35)`;
    const s = 6 + Math.random() * 26;
    g.fillRect(Math.random() * 256, Math.random() * 512, s, s);
  }
  // bright edge lines + dense high-contrast dashes — the speed readout
  g.fillStyle = 'rgba(235, 230, 214, 0.85)';
  g.fillRect(10, 0, 6, 512);
  g.fillRect(240, 0, 6, 512);
  g.fillStyle = 'rgba(255, 205, 60, 0.9)';
  for (let y = 6; y < 512; y += 56) {
    g.fillRect(121, y, 6, 30);
    g.fillRect(129, y, 6, 30);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

type BuildingKind = 'glass' | 'concrete' | 'brick';

/** albedo + normal + roughness for a facade so flat box faces catch light with
 *  real relief (recessed windows, panel seams, brick courses). */
function makeBuildingTextures(kind: BuildingKind, cols: number, floors: number, tint: number) {
  const S = 256;
  const alb = document.createElement('canvas'); alb.width = alb.height = S;
  const nrm = document.createElement('canvas'); nrm.width = nrm.height = S;
  const rgh = document.createElement('canvas'); rgh.width = rgh.height = S;
  const a = alb.getContext('2d')!;
  const n = nrm.getContext('2d')!;
  const r = rgh.getContext('2d')!;
  const base = new THREE.Color(tint);
  n.fillStyle = 'rgb(128,128,255)'; n.fillRect(0, 0, S, S);           // flat normal
  r.fillStyle = kind === 'glass' ? '#333' : '#c8c8c8'; r.fillRect(0, 0, S, S);

  // paint a faked inset bevel into the normal map (windows/panels recessed)
  const bevel = (x: number, y: number, w: number, h: number, e = 3) => {
    n.fillStyle = 'rgb(90,128,235)'; n.fillRect(x, y, e, h);          // left → +X tilt
    n.fillStyle = 'rgb(166,128,235)'; n.fillRect(x + w - e, y, e, h); // right → -X tilt
    n.fillStyle = 'rgb(128,90,235)'; n.fillRect(x, y, w, e);          // top → +Y tilt
    n.fillStyle = 'rgb(128,166,235)'; n.fillRect(x, y + h - e, w, e); // bottom → -Y tilt
  };

  if (kind === 'brick') {
    // brick courses, offset rows
    a.fillStyle = `rgb(${base.r * 210 | 0},${base.g * 150 | 0},${base.b * 140 | 0})`;
    a.fillRect(0, 0, S, S);
    const bh = 9, bw = 26;
    for (let y = 0, row = 0; y < S; y += bh, row++) {
      for (let x = -bw; x < S; x += bw) {
        const ox = (row % 2) * (bw / 2);
        const v = 0.75 + Math.random() * 0.35;
        a.fillStyle = `rgb(${base.r * 210 * v | 0},${base.g * 150 * v | 0},${base.b * 138 * v | 0})`;
        a.fillRect(x + ox + 1, y + 1, bw - 2, bh - 2);
      }
      n.fillStyle = 'rgb(128,150,240)'; n.fillRect(0, y, S, 1.5);      // mortar course relief
    }
  } else if (kind === 'concrete') {
    a.fillStyle = `rgb(${base.r * 200 | 0},${base.g * 200 | 0},${base.b * 205 | 0})`;
    a.fillRect(0, 0, S, S);
    for (let i = 0; i < 260; i++) {                                    // weathering blotches + stains
      a.fillStyle = `rgba(${20 + Math.random() * 60},${20 + Math.random() * 55},${28 + Math.random() * 55},${0.06 + Math.random() * 0.14})`;
      const s = 6 + Math.random() * 34;
      a.fillRect(Math.random() * S, Math.random() * S, s, s);
    }
    for (let x = 0; x < S; x += S / cols) { n.fillStyle = 'rgb(150,128,240)'; n.fillRect(x, 0, 1.5, S); }
  } else {
    a.fillStyle = `rgb(${18 + base.r * 40 | 0},${24 + base.g * 46 | 0},${38 + base.b * 60 | 0})`;
    a.fillRect(0, 0, S, S);                                           // dark glass curtain wall
  }

  // window grid — recessed panels, some warmly lit (interiors)
  const mx = 14, my = 12;
  const cw = (S - mx * 2) / cols;
  const ch = (S - my * 2) / floors;
  const gw = cw * (kind === 'glass' ? 0.82 : 0.6);
  const gh = ch * (kind === 'glass' ? 0.74 : 0.58);
  for (let fx = 0; fx < cols; fx++) {
    for (let fy = 0; fy < floors; fy++) {
      const wx = mx + fx * cw + (cw - gw) / 2;
      const wy = my + fy * ch + (ch - gh) / 2;
      const lit = Math.random() < 0.4;
      a.fillStyle = lit
        ? `rgba(${232 + Math.random() * 22},${186 + Math.random() * 40},${96 + Math.random() * 46},0.96)`
        : `rgba(${14 + Math.random() * 16},${20 + Math.random() * 20},${34 + Math.random() * 26},0.96)`;
      a.fillRect(wx, wy, gw, gh);
      bevel(wx, wy, gw, gh);
      r.fillStyle = lit ? '#e0e0e0' : '#202028';                      // glass is glossy
      r.fillRect(wx, wy, gw, gh);
    }
  }

  const map = new THREE.CanvasTexture(alb); map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = new THREE.CanvasTexture(nrm);
  const roughnessMap = new THREE.CanvasTexture(rgh);
  return { map, normalMap, roughnessMap };
}

function makeSignTexture(lines: string[], bg: string, fg: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, 512, 256);
  g.strokeStyle = fg;
  g.lineWidth = 10;
  g.strokeRect(12, 12, 488, 232);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const fs = lines.length > 1 ? 64 : 84;
  g.font = `italic 900 ${fs}px "Arial Black", sans-serif`;
  lines.forEach((line, i) => {
    g.fillText(line, 256, 128 + (i - (lines.length - 1) / 2) * (fs + 14));
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------- arena

export function buildArena(world: RAPIER.World, scene: THREE.Scene, forcedSkyIdx?: number): ArenaData {
  const H = ARENA_HALF;

  // --- sky: real gradient dome + sun + stars, three moods rotating per match ---
  // fog is tuned to each preset's HORIZON color so distant buildings melt
  // into the sky instead of silhouetting against it
  const SKY_PRESETS = [
    { name: 'sunset', top: '#1a0f2e', mid: '#4a2545', hor: '#c96a2e', sunColor: 0xffb070, sunI: 3.4, hemiS: 0xb09adf, hemiG: 0x5a4a58, hemiI: 1.8, fog: 0x84492c, sil: '#2c1830', stars: true, sunPos: [90, 42, 60] as const, sunVis: '#ffcc88' },
    { name: 'day', top: '#3a7bd5', mid: '#7db8e8', hor: '#d8e8f0', sunColor: 0xfff4e0, sunI: 3.8, hemiS: 0xcfe8ff, hemiG: 0x8a8578, hemiI: 2.4, fog: 0xc2d8e8, sil: '#8aa4bc', stars: false, sunPos: [70, 120, 40] as const, sunVis: '#ffffff' },
    { name: 'night', top: '#05060f', mid: '#0c1226', hor: '#1c2a4a', sunColor: 0xaac8ff, sunI: 1.2, hemiS: 0x4a5a9c, hemiG: 0x1c1c2a, hemiI: 1.1, fog: 0x141e34, sil: '#080b16', stars: true, sunPos: [60, 90, -80] as const, sunVis: '#e8f0ff' },
  ];
  const skyIdx = forcedSkyIdx ?? Math.floor(Math.random() * SKY_PRESETS.length);
  const sky = SKY_PRESETS[skyIdx];

  // gradient dome
  const domeCanvas = document.createElement('canvas');
  domeCanvas.width = 2; domeCanvas.height = 512;
  const dg = domeCanvas.getContext('2d')!;
  const grad = dg.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, sky.top);
  grad.addColorStop(0.55, sky.mid);
  grad.addColorStop(0.82, sky.hor);
  grad.addColorStop(1, sky.hor);
  dg.fillStyle = grad;
  dg.fillRect(0, 0, 2, 512);
  const domeTex = new THREE.CanvasTexture(domeCanvas);
  domeTex.colorSpace = THREE.SRGBColorSpace;
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(520, 24, 16),
    new THREE.MeshBasicMaterial({ map: domeTex, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  dome.renderOrder = -10;
  scene.add(dome);

  // visible sun/moon disc aligned with the light direction
  const sunDisc = new THREE.Mesh(
    new THREE.CircleGeometry(sky.name === 'day' ? 30 : 22, 24),
    new THREE.MeshBasicMaterial({ color: sky.sunVis, fog: false }),
  );
  sunDisc.position.set(sky.sunPos[0], sky.sunPos[1], sky.sunPos[2]).normalize();
  sunDisc.position.multiplyScalar(490);
  sunDisc.lookAt(0, 0, 0);
  sunDisc.renderOrder = -9;
  scene.add(sunDisc);

  // stars on the upper dome
  if (sky.stars) {
    const starPos = new Float32Array(500 * 3);
    for (let i = 0; i < 500; i++) {
      const a = Math.random() * Math.PI * 2;
      const el = 0.12 + Math.random() * 1.4;
      const r = 495;
      starPos[i * 3] = Math.cos(a) * Math.cos(el) * r;
      starPos[i * 3 + 1] = Math.sin(el) * r;
      starPos[i * 3 + 2] = Math.sin(a) * Math.cos(el) * r;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xffffff, size: 1.7, sizeAttenuation: false, fog: false,
      transparent: true, opacity: sky.name === 'night' ? 0.9 : 0.45,
    }));
    stars.renderOrder = -9;
    scene.add(stars);
  }

  // distant low-poly skyline ring: sits inside the fog band so it reads as a
  // hazy far cityscape and hides the arena edge
  {
    const sc = document.createElement('canvas');
    sc.width = 1024; sc.height = 128;
    const sg = sc.getContext('2d')!;
    sg.fillStyle = sky.sil;
    let x = 0;
    while (x < 1024) {
      const w = 22 + Math.random() * 52;
      const h = 22 + Math.random() * 78;
      sg.fillRect(x, 128 - h, w, h);
      // sparse lit windows on the dark presets
      if (sky.name !== 'day') {
        sg.fillStyle = 'rgba(255, 214, 140, 0.55)';
        for (let k = 0; k < w * h * 0.002; k++) {
          sg.fillRect(x + 3 + Math.random() * (w - 6), 128 - h + 4 + Math.random() * (h - 8), 2, 3);
        }
        sg.fillStyle = sky.sil;
      }
      x += w + 4 + Math.random() * 18;
    }
    const silTex = new THREE.CanvasTexture(sc);
    silTex.wrapS = THREE.RepeatWrapping;
    silTex.repeat.set(3, 1);
    silTex.colorSpace = THREE.SRGBColorSpace;
    const skyline = new THREE.Mesh(
      new THREE.CylinderGeometry(300, 300, 64, 48, 1, true),
      new THREE.MeshBasicMaterial({ map: silTex, transparent: true, side: THREE.BackSide, fog: true }),
    );
    skyline.position.y = 30;
    scene.add(skyline);
  }

  scene.background = new THREE.Color(sky.top);
  scene.fog = new THREE.Fog(sky.fog, 130, 390);

  const hemi = new THREE.HemisphereLight(sky.hemiS, sky.hemiG, sky.hemiI);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(sky.sunColor, sky.sunI);
  sun.position.set(sky.sunPos[0], sky.sunPos[1], sky.sunPos[2]);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -H - 10;
  sun.shadow.camera.right = H + 10;
  sun.shadow.camera.top = H + 10;
  sun.shadow.camera.bottom = -H - 10;
  sun.shadow.camera.far = 400;
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  // --- ground ---
  const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(H, 0.5, H).setTranslation(0, -0.5, 0).setFriction(0.7), floorBody);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(H * 2, H * 2),
    new THREE.MeshStandardMaterial({ map: makeGroundTexture(), roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // --- roads ---
  const roadPlane = (cx: number, cz: number, w: number, len: number, rotZ: number, y = 0.03) => {
    const tex = makeRoadTexture();
    tex.repeat.set(1, Math.max(1, Math.round(len / 26)));
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, len),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = rotZ;
    mesh.position.set(cx, y, cz);
    mesh.receiveShadow = true;
    scene.add(mesh);
  };

  // boulevards (18 wide = 9× vehicle width), drawn above the ring at crossings
  roadPlane(0, 0, 18, H * 2, 0, 0.05);
  roadPlane(0, 0, 18, H * 2, Math.PI / 2, 0.045);
  // intersection patch
  const patch = new THREE.Mesh(
    new THREE.PlaneGeometry(18.2, 18.2),
    new THREE.MeshStandardMaterial({ color: 0x26242c, roughness: 0.92 }),
  );
  patch.rotation.x = -Math.PI / 2;
  patch.position.set(0, 0.07, 0);
  patch.receiveShadow = true;
  scene.add(patch);

  // ring highway (20 wide = 10× vehicle width) — chamfered octagon, no 90° turns
  roadPlane(0, -78, 20, 64, Math.PI / 2);
  roadPlane(0, 78, 20, 64, Math.PI / 2);
  roadPlane(78, 0, 20, 64, 0);
  roadPlane(-78, 0, 20, 64, 0);
  roadPlane(55, -55, 20, 66, Math.PI / 4);
  roadPlane(-55, 55, 20, 66, Math.PI / 4);
  roadPlane(55, 55, 20, 66, -Math.PI / 4);
  roadPlane(-55, -55, 20, 66, -Math.PI / 4);

  // sidewalks flanking the boulevards
  const walkMat = new THREE.MeshStandardMaterial({ color: 0x5c5662, roughness: 0.9 });
  for (const off of [-11.2, 11.2]) {
    const wNS = new THREE.Mesh(new THREE.PlaneGeometry(4.5, H * 2), walkMat);
    wNS.rotation.x = -Math.PI / 2;
    wNS.position.set(off, 0.015, 0);
    wNS.receiveShadow = true;
    scene.add(wNS);
    const wEW = new THREE.Mesh(new THREE.PlaneGeometry(H * 2, 4.5), walkMat);
    wEW.rotation.x = -Math.PI / 2;
    wEW.position.set(0, 0.012, off);
    wEW.receiveShadow = true;
    scene.add(wEW);
  }

  // --- materials ---
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x4d4460, roughness: 0.9 });
  const rampMat = new THREE.MeshStandardMaterial({ color: 0x6e6455, roughness: 0.75 });
  const platMat = new THREE.MeshStandardMaterial({ color: 0x46516b, roughness: 0.8 });
  const neonMat = new THREE.MeshStandardMaterial({ color: 0xff6a00, emissive: 0xff5500, emissiveIntensity: 2.2, roughness: 0.4 });
  const neonCyanMat = new THREE.MeshStandardMaterial({ color: 0x22ccff, emissive: 0x11aaff, emissiveIntensity: 2.0, roughness: 0.4 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x24202c, roughness: 0.95 });
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0x33303c, roughness: 0.8 });

  // --- perimeter walls + neon trim ---
  const wallH = 4;
  addBox(world, scene, wallMat, 0, wallH / 2, -H - 1, H + 2, wallH / 2, 1);
  addBox(world, scene, wallMat, 0, wallH / 2, H + 1, H + 2, wallH / 2, 1);
  addBox(world, scene, wallMat, -H - 1, wallH / 2, 0, 1, wallH / 2, H + 2);
  addBox(world, scene, wallMat, H + 1, wallH / 2, 0, 1, wallH / 2, H + 2);
  addDecoBox(scene, neonMat, 0, wallH + 0.15, -H - 1, H + 2, 0.12, 0.5);
  addDecoBox(scene, neonMat, 0, wallH + 0.15, H + 1, H + 2, 0.12, 0.5);
  addDecoBox(scene, neonMat, -H - 1, wallH + 0.15, 0, 0.5, 0.12, H + 2);
  addDecoBox(scene, neonMat, H + 1, wallH + 0.15, 0, 0.5, 0.12, H + 2);

  // --- central interchange: N-S boulevard bridges the E-W street (widened) ---
  const deckTop = 3.7;
  addBox(world, scene, platMat, 0, (deckTop - 0.6) / 2, -8.2, 10, (deckTop - 0.6) / 2, 1.2);
  addBox(world, scene, platMat, 0, (deckTop - 0.6) / 2, 8.2, 10, (deckTop - 0.6) / 2, 1.2);
  addBox(world, scene, platMat, 0, deckTop - 0.3, 0, 10, 0.3, 9.4);
  addDecoBox(scene, neonCyanMat, 0, deckTop + 0.08, -9.25, 10, 0.1, 0.15);
  addDecoBox(scene, neonCyanMat, 0, deckTop + 0.08, 9.25, 10, 0.1, 0.15);
  addBox(world, scene, platMat, -9.6, deckTop + 0.25, 0, 0.4, 0.25, 9.4);
  addBox(world, scene, platMat, 9.6, deckTop + 0.25, 0, 0.4, 0.25, 9.4);
  // high end must face the deck: yaw π when approaching from +Z, yaw 0 from -Z
  addRamp(world, scene, rampMat, 0, 17, Math.PI, 14, 10, deckTop - 0.15);  // south approach
  addRamp(world, scene, rampMat, 0, -17, 0, 14, 10, deckTop - 0.15);       // north approach

  // --- city blocks: 4 buildings per quadrant, alleys ≥13m (6.5×) ---
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x2a2530, roughness: 0.7, metalness: 0.35 });
  const ventMat = new THREE.MeshStandardMaterial({ color: 0x3a3640, roughness: 0.6, metalness: 0.5 });
  const KINDS: BuildingKind[] = ['glass', 'concrete', 'brick'];
  const building = (cx: number, cz: number, hx: number, hy: number, hz: number, tint: number, yaw = 0, kindIdx = 0) => {
    const kind = KINDS[kindIdx % 3];
    const cols = Math.max(3, Math.round(hx * 0.95));
    const floors = Math.max(3, Math.round(hy * 0.85));
    const tex = makeBuildingTextures(kind, cols, floors, tint);
    const sideMat = new THREE.MeshStandardMaterial({
      map: tex.map, normalMap: tex.normalMap, roughnessMap: tex.roughnessMap,
      normalScale: new THREE.Vector2(0.8, 0.8),
      metalness: kind === 'glass' ? 0.55 : 0.1, roughness: 0.9,
      emissive: 0xffffff, emissiveMap: tex.map, emissiveIntensity: kind === 'glass' ? 0.18 : 0.32,
    });
    // main mass keeps the full-footprint collider
    addProp(world, scene, [sideMat, sideMat, roofMat, roofMat, sideMat, sideMat], cx, hy, cz, hx, hy, hz, yaw);

    // --- decorative architecture (no colliders) ---
    const q = yaw;
    // base plinth — a darker, slightly wider ground band
    addDecoBox(scene, trimMat, cx, 0.7, cz, hx * 1.04, 0.7, hz * 1.04, q);
    // parapet cap ringing the roof (cornice)
    addDecoBox(scene, trimMat, cx, hy * 2 + 0.25, cz, hx * 1.03, 0.35, hz * 1.03, q);
    // horizontal floor ledges break up the facade
    const bands = Math.max(1, Math.round(hy / 2.5));
    for (let b = 1; b <= bands; b++) {
      const by = (hy * 2) * (b / (bands + 1));
      addDecoBox(scene, trimMat, cx, by, cz, hx * 1.015, 0.14, hz * 1.015, q);
    }
    // corner pilasters — vertical relief that gives real silhouette
    const cxr = Math.cos(q), szr = Math.sin(q);
    for (const [ox, oz] of [[-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz]] as const) {
      const px = cx + ox * cxr - oz * szr;
      const pz = cz + ox * szr + oz * cxr;
      addDecoBox(scene, trimMat, px, hy, pz, 0.35, hy, 0.35, q);
    }
    // rooftop clutter — AC units, vents, a stair penthouse
    const roofY = hy * 2 + 0.5;
    addDecoBox(scene, ventMat, cx + hx * 0.3, roofY + 0.4, cz - hz * 0.2, hx * 0.35, 0.6, hz * 0.28, q);
    addDecoBox(scene, ventMat, cx - hx * 0.35, roofY + 0.25, cz + hz * 0.3, 0.5, 0.4, 0.5, q);
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 1.4, 8), ventMat);
    stack.position.set(cx - hx * 0.2, roofY + 0.7, cz - hz * 0.35);
    stack.castShadow = true;
    scene.add(stack);
  };
  const blocks: [number, number, number, number, number][] = [
    [26, 26, 6, 3.5, 6],
    [52, 30, 7, 5, 6],
    [30, 54, 6, 7, 6],
    [56, 56, 6, 4.5, 5],
  ];
  const tints = [0x4a3f55, 0x5c4438, 0x52405c, 0x40485a, 0x55404a, 0x463c58, 0x584842, 0x3f4652];
  let ti = 0;
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
    blocks.forEach(([bx, bz, hx, hy, hz], i) => {
      const hVar = hy + ((sx * 3 + sz * 5 + i) % 3) * 0.8;
      building(bx * sx, bz * sz, hx, hVar, hz, tints[ti % tints.length], (sx * sz * (i + 1)) * 0.06, ti++);
    });
  }

  // --- rooftop billboards ---
  const billboard = (x: number, y: number, z: number, yaw: number, lines: string[], bg: string, fg: string) => {
    const tex = makeSignTexture(lines, bg, fg);
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(11, 5.5),
      new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.7, side: THREE.DoubleSide }),
    );
    panel.position.set(x, y, z);
    panel.rotation.y = yaw;
    scene.add(panel);
    addDecoBox(scene, canopyMat, x, y - 3.4, z, 0.3, 1.2, 0.3, yaw);
  };
  billboard(30, 18.5, 54, Math.PI * 0.25, ['STEEL', 'RAMPAGE'], '#1a1020', '#ff7a20');
  billboard(-30, 18.5, -54, Math.PI * 1.25, ["VINNY'S", 'AUTO PARTS'], '#102018', '#7dffb0');

  // --- gas station (SE outer apron) ---
  building(106, -102, 4, 2.5, 3, 0x3c4048);
  addDecoBox(scene, canopyMat, 98, 4.6, -92, 6, 0.3, 5);
  addDecoBox(scene, neonCyanMat, 98, 4.25, -92, 6.05, 0.08, 5.05);
  for (const [px, pz] of [[93.5, -88], [102.5, -88], [93.5, -96], [102.5, -96]] as const) {
    addProp(world, scene, canopyMat, px, 2.2, pz, 0.3, 2.2, 0.3);
  }
  const gasTex = makeSignTexture(['GAS'], '#701818', '#ffd898');
  const gasSign = new THREE.Mesh(
    new THREE.PlaneGeometry(5, 2.5),
    new THREE.MeshStandardMaterial({ map: gasTex, emissive: 0xffffff, emissiveMap: gasTex, emissiveIntensity: 0.8, side: THREE.DoubleSide }),
  );
  gasSign.position.set(91, 5.8, -92);
  gasSign.rotation.y = -Math.PI / 2;
  scene.add(gasSign);
  addProp(world, scene, canopyMat, 91, 2.2, -92, 0.3, 2.2, 0.3);

  // --- shield bunkers (outer apron, E and W) ---
  const bunkerMat = new THREE.MeshStandardMaterial({ color: 0x6b5e82, roughness: 0.85 });
  addProp(world, scene, bunkerMat, 104, 1.8, -14, 1, 1.8, 7);
  addProp(world, scene, bunkerMat, 98, 1.8, -8, 7, 1.8, 1);
  addProp(world, scene, bunkerMat, -104, 1.8, 14, 1, 1.8, 7);
  addProp(world, scene, bunkerMat, -98, 1.8, 8, 7, 1.8, 1);

  // --- stunt ramps on the outer apron ---
  addRamp(world, scene, rampMat, 100, 34, -Math.PI / 2, 10, 7, 2.6);
  addRamp(world, scene, rampMat, -100, -34, Math.PI / 2, 10, 7, 2.6);
  addRamp(world, scene, rampMat, 34, 100, Math.PI, 10, 7, 2.6);
  addRamp(world, scene, rampMat, -34, -100, 0, 10, 7, 2.6);

  // --- streetlights (thin colliders: 0.10 physics vs 0.14 visual) ---
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2c2836, roughness: 0.8 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffe6b0, emissive: 0xffc86a, emissiveIntensity: 2.6 });
  const streetlight = (x: number, z: number, facing: number) => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 2.6, z));
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.1, 2.6, 0.1), body);
    addDecoBox(scene, poleMat, x, 2.6, z, 0.14, 2.6, 0.14);
    const armX = x + Math.sin(facing) * 1.4;
    const armZ = z + Math.cos(facing) * 1.4;
    addDecoBox(scene, poleMat, (x + armX) / 2, 5.1, (z + armZ) / 2, Math.abs(armX - x) / 2 + 0.08, 0.08, Math.abs(armZ - z) / 2 + 0.08);
    addDecoBox(scene, lampMat, armX, 5.0, armZ, 0.35, 0.1, 0.35);
  };
  for (const c of [-100, -70, -40, 40, 70, 100]) {
    streetlight(-12.8, c, Math.PI / 2);
    streetlight(12.8, c, -Math.PI / 2);
    streetlight(c, -12.8, 0);
    streetlight(c, 12.8, Math.PI);
  }

  // --- corner light towers ---
  for (const [px, pz] of [[-114, -114], [114, -114], [-114, 114], [114, 114]] as const) {
    addDecoBox(scene, poleMat, px, 6, pz, 0.5, 6, 0.5);
    addDecoBox(scene, neonCyanMat, px, 12.2, pz, 1.1, 0.35, 1.1);
  }

  // --- street clutter (rounded colliders — no snagging) ---
  const wreckMat = new THREE.MeshStandardMaterial({ color: 0x3a3230, roughness: 0.95, metalness: 0.3 });
  const wreck = (x: number, z: number, yaw: number) => {
    addProp(world, scene, wreckMat, x, 0.55, z, 0.95, 0.55, 2.0, yaw);
    addDecoBox(scene, wreckMat, x, 1.25, z, 0.8, 0.28, 1.0, yaw);
  };
  wreck(15, -52, 0.25);
  wreck(-15, 34, -0.12);
  wreck(15.5, 88, 2.9);
  wreck(-95, -15, 1.7);   // off the ring's west lane — was a highway snag
  const dumpMat = new THREE.MeshStandardMaterial({ color: 0x2a4034, roughness: 0.9 });
  addProp(world, scene, dumpMat, -44, 1, 44, 2, 1, 1, 0.3);
  addProp(world, scene, dumpMat, 44, 1, -44, 2, 1, 1, -0.4);

  // --- the SKYWAY: an elevated roller-coaster track you drive with full
  //     control — on-ramps both ends, rolling humps, guard rails, real physics ---
  const trackMat = new THREE.MeshStandardMaterial({
    color: 0xff6d00, roughness: 0.5, metalness: 0.2,
    emissive: 0xff4400, emissiveIntensity: 0.25,
  });
  const railMat = new THREE.MeshStandardMaterial({
    color: 0xffa040, emissive: 0xff7710, emissiveIntensity: 1.4, roughness: 0.4,
  });
  const SKY_Z = -78;
  const skySeg = (x0: number, x1: number, yA: number, yB: number) => {
    const len = Math.hypot(x1 - x0, yB - yA);
    const phi = Math.atan2(yB - yA, x1 - x0);
    const cx = (x0 + x1) / 2;
    const cy = (yA + yB) / 2 - 0.25;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), phi);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, SKY_Z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(len / 2, 0.25, 5).setFriction(0.7), body);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(len, 0.5, 10), trackMat);
    deck.position.set(cx, cy, SKY_Z);
    deck.quaternion.copy(q);
    deck.castShadow = true;
    deck.receiveShadow = true;
    scene.add(deck);
    // guard rails (collidable — keeps you on at speed, still jumpable over humps)
    for (const zOff of [-4.85, 4.85]) {
      const railBody = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy + 0.55, SKY_Z + zOff).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
      );
      world.createCollider(RAPIER.ColliderDesc.cuboid(len / 2, 0.3, 0.15).setFriction(0.1), railBody);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.6, 0.3), railMat);
      rail.position.set(cx, cy + 0.55, SKY_Z + zOff);
      rail.quaternion.copy(q);
      scene.add(rail);
    }
    // support pylons every segment
    addDecoBox(scene, canopyMat, cx, cy / 2, SKY_Z + 4, 0.4, Math.max(0.4, cy / 2), 0.4);
    addDecoBox(scene, canopyMat, cx, cy / 2, SKY_Z - 4, 0.4, Math.max(0.4, cy / 2), 0.4);
  };
  // profile: west on-ramp → flats & humps (airtime at speed) → east on-ramp
  skySeg(-68, -48, 0.1, 6.5);    // west climb
  skySeg(-48, -36, 6.5, 6.5);
  skySeg(-36, -26, 6.5, 5.6);    // gentle dip
  skySeg(-26, -12, 5.6, 7.4);    // crest — airtime only at boosted speeds
  skySeg(-12, 0, 7.4, 6.2);
  skySeg(0, 10, 6.2, 6.2);       // flat (boost pad)
  skySeg(10, 22, 6.2, 7.0);      // second crest
  skySeg(22, 34, 7.0, 5.8);
  skySeg(34, 48, 5.8, 6.5);
  skySeg(48, 68, 6.5, 0.1);      // east descent

  const boostPads: ArenaData['boostPads'] = [];
  const chevronTex = (() => {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(255, 150, 20, 0.95)';
    for (const off of [0, 44, 88]) {
      g.beginPath();
      g.moveTo(off, 8); g.lineTo(off + 30, 32); g.lineTo(off, 56);
      g.lineTo(off + 14, 56); g.lineTo(off + 44, 32); g.lineTo(off + 14, 8);
      g.closePath();
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const buildPad = (x: number, z: number, alongX: boolean, y = 0) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(7, 3.6),
      new THREE.MeshStandardMaterial({
        map: chevronTex, transparent: true,
        emissive: 0xffffff, emissiveMap: chevronTex, emissiveIntensity: 1.1,
        roughness: 0.6,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    if (!alongX) mesh.rotation.z = Math.PI / 2;
    mesh.position.set(x, y + 0.09, z);
    scene.add(mesh);
    boostPads.push(alongX ? { x, y, z, hx: 3.5, hz: 1.8 } : { x, y, z, hx: 1.8, hz: 3.5 });
  };
  buildPad(-58, -78, true);   // skyway west approach (under the on-ramp start)
  buildPad(58, -78, true);    // skyway east approach
  buildPad(5, -78, true, 6.2); // ON the skyway deck — chain the humps at speed
  buildPad(-26, 78, true);    // south ring straight
  buildPad(26, 78, true);
  buildPad(0, -52, false);    // boulevard approaches
  buildPad(0, 52, false);
  buildPad(-52, 0, true);
  buildPad(52, 0, true);

  // --- spawn points: on the ring, facing along it ---
  const spawnPoints = [
    { pos: new THREE.Vector3(78, 1.2, 0), yaw: 0 },
    { pos: new THREE.Vector3(-78, 1.2, 0), yaw: Math.PI },
    { pos: new THREE.Vector3(0, 1.2, 78), yaw: Math.PI / 2 },
    { pos: new THREE.Vector3(0, 1.2, -78), yaw: -Math.PI / 2 },
    { pos: new THREE.Vector3(55, 1.2, 55), yaw: Math.PI * 0.25 },
    { pos: new THREE.Vector3(-55, 1.2, -55), yaw: -Math.PI * 0.75 },
    { pos: new THREE.Vector3(55, 1.2, -55), yaw: -Math.PI * 0.25 },
    { pos: new THREE.Vector3(-55, 1.2, 55), yaw: Math.PI * 0.75 },
  ];

  // --- items: offense central/high-risk, defense peripheral (LEVEL-DESIGN.md §4) ---
  const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const pickupPoints: ArenaData['pickupPoints'] = [
    // HIGH-RISK / OFFENSE
    { pos: P(0, deckTop + 1.0, 0), type: 'missiles' },              // bridge deck
    { pos: P(0, 0.9, 0), type: 'overdrive', alts: [P(0, 0.9, 0), P(41, 0.9, 41), P(-41, 0.9, -41)] }, // roams
    { pos: P(78, 0.9, 0), type: 'missiles' },                       // ring medians
    { pos: P(-78, 0.9, 0), type: 'missiles' },
    { pos: P(20, 0.9, -78), type: 'missiles' },   // under the skyway
    { pos: P(-20, 0.9, 78), type: 'missiles' },
    { pos: P(-12, 8.5, -78), type: 'missiles' },  // skyway big crest — earn it
    { pos: P(22, 8.1, -78), type: 'turbo' },      // skyway second crest
    { pos: P(41, 0.9, -41), type: 'mines' },                        // plaza pockets
    { pos: P(-41, 0.9, 41), type: 'mines' },
    { pos: P(38, 0.9, -28), type: 'mines' },
    // PERIPHERAL / DEFENSE & UTILITY
    { pos: P(100, 0.9, -11), type: 'shield' },                      // bunkers
    { pos: P(-100, 0.9, 11), type: 'shield' },
    { pos: P(105, 0.9, 105), type: 'turbo' },                       // outer corners
    { pos: P(-105, 0.9, -105), type: 'turbo' },
    { pos: P(-105, 0.9, 60), type: 'turbo' },
    { pos: P(38, 0.9, 28), type: 'health' },                        // quadrant alleys
    { pos: P(-38, 0.9, -28), type: 'health' },
    { pos: P(0, 0.9, -105), type: 'health' },
    { pos: P(-38, 0.9, 28), type: 'health' },
  ];

  const barrelPoints = [
    // gas station cluster
    P(98, 0.95, -92).clone(), P(96, 0.95, -89), P(99.5, 0.95, -89.5),
    // ring chamfer hazards
    P(62, 0.95, 48), P(-62, 0.95, -48), P(48, 0.95, -62), P(-48, 0.95, 62),
    // boulevard median hazards
    P(0, 0.95, 40), P(0, 0.95, -40), P(40, 0.95, 0), P(-40, 0.95, 0),
  ];

  // --- pedestrian zones: sidewalks + plaza pockets ---
  const pedZones: PedZone[] = [
    { x: 12.8, z: -60, hx: 1.8, hz: 45 },
    { x: -12.8, z: 60, hx: 1.8, hz: 45 },
    { x: 60, z: 12.8, hx: 45, hz: 1.8 },
    { x: -60, z: -12.8, hx: 45, hz: 1.8 },
    { x: 41, z: 41, hx: 4, hz: 4 },
    { x: -41, z: -41, hx: 4, hz: 4 },
    { x: 41, z: -41, hx: 4, hz: 4 },
    { x: -41, z: 41, hx: 4, hz: 4 },
  ];

  return { spawnPoints, pickupPoints, barrelPoints, pedZones, boostPads, skyIdx };
}
