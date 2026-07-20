import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CarSpec } from '../game/specs';

/** Kenney Car Kit (CC0) — real car bodies; wheels come as separate models
 *  so our suspension/steering wheel rig keeps working. */

export interface CarModel {
  body: THREE.Group;
  wheel: THREE.Object3D;
}

const BODY_FILES: Record<CarSpec['build'], string> = {
  speed: 'race',
  muscle: 'sedan-sports',
  sports: 'race-future',
  suv: 'police',
  tank: 'truck',
  hearse: 'van',
  ambulance: 'ambulance',
  taxi: 'taxi',
};

const WHEEL_FILES: Record<CarSpec['build'], string> = {
  speed: 'wheel-racing',
  muscle: 'wheel-default',
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
      loader.load(`/models/${name}.glb`, (gltf) => resolve(gltf.scene), undefined, reject);
    });

  try {
    const builds = Object.keys(BODY_FILES) as CarSpec['build'][];
    const wheelNames = [...new Set(Object.values(WHEEL_FILES))];
    const [bodies, wheels] = await Promise.all([
      Promise.all(builds.map((b) => load(BODY_FILES[b]))),
      Promise.all(wheelNames.map((w) => load(w))),
    ]);
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
