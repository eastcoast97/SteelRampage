import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CarSpec } from '../game/specs';
import { assetUrl } from '../assets';

/** Kenney Car Kit (CC0) — real car bodies; wheels come as separate models
 *  so our suspension/steering wheel rig keeps working. */

export interface CarModel {
  body: THREE.Group;
  wheel: THREE.Object3D;
}

/** Yaw correction (radians) applied at load time for models that don't come in
 *  with their length along -Z. AI-generated meshes in particular arrive on an
 *  arbitrary axis — the Higgsfield car's length is along X, so it needs a
 *  quarter turn before carMesh measures and scales it. */
const MODEL_YAW: Partial<Record<CarSpec['build'], number>> = {
  // every Higgsfield/Meshy car comes out with its length on X and nose at -X
  // (they inherit the hero image's framing), so they all take the same turn
  speed: -Math.PI / 2,
  muscle: -Math.PI / 2,
  sports: -Math.PI / 2,
  suv: -Math.PI / 2,
  tank: -Math.PI / 2,
  hearse: -Math.PI / 2,
  ambulance: -Math.PI / 2,
  // the bike came back with its length already on Z, so no correction
};

/** Builds whose GLB ships its own authored PBR textures (AI-generated or
 *  hand-authored). Their materials must be left ALONE — no palette retint, no
 *  shared scratch roughness map, or we'd paint over the real maps. */
export const AUTHORED_TEXTURES = new Set<CarSpec['build']>([
  'speed', 'muscle', 'sports', 'suv', 'tank', 'hearse', 'ambulance', 'bike',
]);
/** Builds whose GLB already contains wheels, so the steer/spin rig must not
 *  mount a second set on top. (The AI muscle body had its wheels boolean-cut
 *  out in Blender — see tools/blender/cut_wheels.py — so it is NOT in here.) */
export const WHEELS_BAKED_IN = new Set<CarSpec['build']>([]);

/** REAPER's chainsaw, generated separately so it can still be posed: the body
 *  mesh is a single fused shell, so anything modelled INTO it is frozen. */
let sawModel: THREE.Group | null = null;
export function getSawModel(): THREE.Group | null { return sawModel; }

/** Yaw correction for wheel models, same reason as MODEL_YAW: the rig expects
 *  the axle along X, and an AI wheel generated from a face-on image comes out
 *  with its axle along Z. Keyed by FILE (not build) because several builds
 *  share one wheel model — rotating a shared group would move all of them. */
const WHEEL_YAW_BY_FILE: Record<string, number> = {
  'hellcat-wheel': Math.PI / 2,
};

// Higgsfield-generated photoreal bodies, wheels boolean-cut out in Blender
// (see docs/BLENDER.md + tools/blender/autocut_wheels.py). A missing file
// degrades that one build to its procedural mesh.
// Partial: REAPER ('bike') is authored in code (render/reaper.ts), so it has no
// GLB at all and must not be looked up here.
const BODY_FILES: Partial<Record<CarSpec['build'], string>> = {
  speed: 'viper-ai',
  muscle: 'hellcat-ai',
  sports: 'scorch-ai',
  suv: 'rampart-ai',
  tank: 'juggernaut-ai',
  hearse: 'mortis-ai',
  ambulance: 'medic-ai',
  bike: 'reaper-ai',       // chopper + rider, generated as one piece
};

// the AI spiked armored wheel is generic enough to serve the whole fleet
const WHEEL_FILES: Partial<Record<CarSpec['build'], string>> = {
  speed: 'hellcat-wheel',
  muscle: 'hellcat-wheel',   // AI-generated spiked armored wheel
  sports: 'hellcat-wheel',
  suv: 'hellcat-wheel',
  tank: 'hellcat-wheel',
  hearse: 'hellcat-wheel',
  ambulance: 'hellcat-wheel',
  // REAPER draws its own two wheels (render/reaper.ts), but the library only
  // registers a build that ALSO resolves a wheel model — without this entry the
  // bike body is silently dropped and the vehicle renders as bare wheels
  bike: 'hellcat-wheel',
};

let library: Map<string, CarModel> | null = null;
const tintedTextures = new Map<number, THREE.CanvasTexture>();
let paletteImage: HTMLImageElement | null = null;
let originalTexture: THREE.Texture | null = null;

export function getCarModel(build: CarSpec['build']): CarModel | null {
  return library?.get(build) ?? null;
}

/** Blender-authored arena assets. Objects named `COL_*` are collision proxies
 *  (see docs/BLENDER.md) — arena.ts turns them into Rapier colliders. */
let arenaBuilding: THREE.Group | null = null;
export function getArenaBuilding(): THREE.Group | null { return arenaBuilding; }

/** The COMPLETE Blender-authored arenas (structures + COL_/SPAWN_/PICKUP_/
 *  BOOST_/PED_/BARREL_/PUMP_ markers). Index matches ARENAS in arena.ts. */
const arenaScenes: (THREE.Group | null)[] = [null, null];
export function getArenaScene(idx = 0): THREE.Group | null { return arenaScenes[idx] ?? null; }

/** Battle-wear pass over a palette canvas: grime mottling, rust speckle and
 *  paint chips. The palette is a UV atlas, so even noise reads as even wear
 *  across the whole body — exactly the sun-beaten TM look. */
function weatherCanvas(g: CanvasRenderingContext2D, w: number, h: number): void {
  // dust/grime mottling
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(${40 + Math.random() * 30},${34 + Math.random() * 24},${24 + Math.random() * 18},${0.05 + Math.random() * 0.1})`;
    const s = 3 + Math.random() * 10;
    g.fillRect(Math.random() * w, Math.random() * h, s, s);
  }
  // rust speckle
  for (let i = 0; i < 420; i++) {
    g.fillStyle = `rgba(${95 + Math.random() * 50},${45 + Math.random() * 25},${18 + Math.random() * 14},${0.25 + Math.random() * 0.35})`;
    const s = 0.6 + Math.random() * 1.8;
    g.fillRect(Math.random() * w, Math.random() * h, s, s);
  }
  // paint chips (bright bare-metal nicks)
  for (let i = 0; i < 140; i++) {
    g.fillStyle = `rgba(${150 + Math.random() * 60},${150 + Math.random() * 55},${145 + Math.random() * 50},${0.3 + Math.random() * 0.3})`;
    g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 1.6, 1 + Math.random() * 1.2);
  }
}

/** weathered copy of the stock palette — for the keep-stock-livery builds */
let weatheredStock: THREE.CanvasTexture | null = null;
export function getWeatheredStockTexture(): THREE.Texture | null {
  if (weatheredStock) return weatheredStock;
  if (!paletteImage || !originalTexture) return originalTexture;
  const c = document.createElement('canvas');
  c.width = paletteImage.width;
  c.height = paletteImage.height;
  const g = c.getContext('2d')!;
  g.drawImage(paletteImage, 0, 0);
  weatherCanvas(g, c.width, c.height);
  weatheredStock = new THREE.CanvasTexture(c);
  weatheredStock.flipY = originalTexture.flipY;
  weatheredStock.wrapS = originalTexture.wrapS;
  weatheredStock.wrapT = originalTexture.wrapT;
  weatheredStock.offset.copy(originalTexture.offset);
  weatheredStock.repeat.copy(originalTexture.repeat);
  weatheredStock.colorSpace = THREE.SRGBColorSpace;
  return weatheredStock;
}

/** Recolor the shared Kenney palette: saturated pixels (paint) take the target
 *  hue; grays (windows, tires, metal) stay untouched. Cached per color. */
export function getTintedTexture(colorHex: number): THREE.Texture | null {
  if (!paletteImage || !originalTexture) return originalTexture;
  const cached = tintedTextures.get(colorHex);
  if (cached) return cached;

  const c = document.createElement('canvas');
  c.width = paletteImage.width;
  c.height = paletteImage.height;
  const g = c.getContext('2d')!;
  g.drawImage(paletteImage, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const target = new THREE.Color(colorHex);
  const tHSL = { h: 0, s: 0, l: 0 };
  target.getHSL(tHSL);
  const px = new THREE.Color();
  const hsl = { h: 0, s: 0, l: 0 };
  for (let i = 0; i < d.length; i += 4) {
    px.setRGB(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
    px.getHSL(hsl);
    if (hsl.s > 0.25 && hsl.l > 0.12) {
      // repaint: keep the pixel's lightness, take the target hue/saturation
      px.setHSL(tHSL.h, Math.max(tHSL.s, 0.05), hsl.l * 0.35 + tHSL.l * 0.65);
      d[i] = px.r * 255; d[i + 1] = px.g * 255; d[i + 2] = px.b * 255;
    }
  }
  g.putImageData(img, 0, 0);
  weatherCanvas(g, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = originalTexture.flipY;
  tex.wrapS = originalTexture.wrapS;
  tex.wrapT = originalTexture.wrapT;
  tex.offset.copy(originalTexture.offset);
  tex.repeat.copy(originalTexture.repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tintedTextures.set(colorHex, tex);
  return tex;
}

export async function loadCarModels(): Promise<void> {
  const loader = new GLTFLoader();
  const load = (name: string) =>
    new Promise<THREE.Group>((resolve, reject) => {
      loader.load(assetUrl(`models/${name}.glb`), (gltf) => resolve(gltf.scene), undefined, reject);
    });

  try {
    const builds = Object.keys(BODY_FILES) as CarSpec['build'][];
    const wheelNames = [...new Set(Object.values(WHEEL_FILES))] as string[];
    const [bodies, wheels, bldg, arena, docks, saw] = await Promise.all([
      // per-body catch: one missing/!corrupt body degrades that single build to
      // the procedural mesh instead of taking the whole library down
      Promise.all(builds.map((b) => load(BODY_FILES[b]!).catch(() => null))),
      // a missing wheel file must not take the whole car library down with it
      Promise.all(wheelNames.map((w) => load(w).catch(() => null))),
      // arena assets authored in Blender — failure here must not block cars
      load('arena-building').catch(() => null),
      load('arena').catch(() => null),
      load('arena-docks').catch(() => null),
      load('reaper-saw').catch(() => null),
    ]);
    arenaBuilding = bldg;
    arenaScenes[0] = arena;
    arenaScenes[1] = docks;
    sawModel = saw;
    const wheelByName = new Map<string, THREE.Group>();
    wheelNames.forEach((n, i) => {
      const w = wheels[i];
      if (!w) return;
      const wy = WHEEL_YAW_BY_FILE[n];
      if (wy) w.rotation.y = wy;   // before anything measures its bbox
      wheelByName.set(n, w);
    });
    library = new Map();
    builds.forEach((b, i) => {
      const body = bodies[i];
      if (!body) return;   // that build falls back to its procedural mesh
      // strip any wheels baked into the body scene (Kenney bodies are wheel-less,
      // but be safe) and enable shadows
      const toRemove: THREE.Object3D[] = [];
      body.traverse((o) => {
        if (/wheel/i.test(o.name)) toRemove.push(o);
        if ((o as THREE.Mesh).isMesh) {
          o.castShadow = true;
          o.receiveShadow = false;
          // capture the shared palette for the tinting system
          const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
          if (!originalTexture && mat?.map?.image) {
            originalTexture = mat.map;
            paletteImage = mat.map.image as HTMLImageElement;
          }
        }
      });
      toRemove.forEach((o) => o.parent?.remove(o));
      // orient before anything downstream measures it (carMesh scales off the
      // Z extent, so the model must already have its length on Z)
      const yaw = MODEL_YAW[b];
      if (yaw) body.rotation.y = yaw;
      const wheel = wheelByName.get(WHEEL_FILES[b]!) ?? wheelByName.get('wheel-default');
      if (wheel) library!.set(b, { body, wheel });
    });
  } catch (err) {
    console.warn('Car models failed to load — falling back to procedural bodies', err);
    library = null;
  }
}
