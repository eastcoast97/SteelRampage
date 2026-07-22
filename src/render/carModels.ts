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

const BODY_FILES: Record<CarSpec['build'], string> = {
  speed: 'race',
  muscle: 'hero-body',   // custom Blender-built body (see docs/BLENDER.md)
  sports: 'race-future',
  suv: 'police',
  tank: 'truck',
  hearse: 'van',
  ambulance: 'ambulance',
  taxi: 'taxi',
};

const WHEEL_FILES: Record<CarSpec['build'], string> = {
  speed: 'wheel-racing',
  muscle: 'hero-wheel',
  sports: 'wheel-racing',
  suv: 'wheel-default',
  tank: 'wheel-truck',
  hearse: 'wheel-default',
  ambulance: 'wheel-default',
  taxi: 'wheel-default',
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
    const wheelNames = [...new Set(Object.values(WHEEL_FILES))];
    const [bodies, wheels, bldg, arena, docks] = await Promise.all([
      Promise.all(builds.map((b) => load(BODY_FILES[b]))),
      Promise.all(wheelNames.map((w) => load(w))),
      // arena assets authored in Blender — failure here must not block cars
      load('arena-building').catch(() => null),
      load('arena').catch(() => null),
      load('arena-docks').catch(() => null),
    ]);
    arenaBuilding = bldg;
    arenaScenes[0] = arena;
    arenaScenes[1] = docks;
    const wheelByName = new Map(wheelNames.map((n, i) => [n, wheels[i]]));
    library = new Map();
    builds.forEach((b, i) => {
      const body = bodies[i];
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
      library!.set(b, { body, wheel: wheelByName.get(WHEEL_FILES[b])! });
    });
  } catch (err) {
    console.warn('Car models failed to load — falling back to procedural bodies', err);
    library = null;
  }
}
