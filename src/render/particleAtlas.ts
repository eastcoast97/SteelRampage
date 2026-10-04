import * as THREE from 'three';

/**
 * Procedural texture atlases for the particle system.
 *
 * Both atlases are 4x4 grids of 128px cells, so a particle picks its look with
 * a single cell index and a flipbook is just "play cells N..M". Everything is
 * generated from value noise at load — there are no sprite sheets to ship, and
 * the fire actually evolves frame to frame instead of being one puff fading
 * out, which is what made the old additive points read as confetti.
 */

const GRID = 4;
const CELL = 128;

/** cell layout of the additive atlas */
export const CELL_FIRE_0 = 0;      // 0..7: fire flipbook, in play order
export const CELL_FIRE_N = 8;
export const CELL_GLOW = 8;        // soft round falloff — flashes, turbo cores
export const CELL_SPARK = 9;       // stretched streak, oriented by velocity
export const CELL_RING = 10;       // shockwave / blast ring
export const CELL_EMBER = 11;      // small hard dot with a soft halo

/** cell layout of the alpha atlas: 0..15 are all smoke variants */
export const CELL_SMOKE_0 = 0;
export const CELL_SMOKE_N = 8;

/** 2D value noise — hash-based so the atlas is identical every run */
function makeNoise(seed: number) {
  const hash = (x: number, y: number) => {
    let h = (x * 374761393 + y * 668265263 + seed * 1442695040) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const value = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = hash(xi, yi), b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return (a + (b - a) * xf) * (1 - yf) + (c + (d - c) * xf) * yf;
  };
  return (x: number, y: number, octaves = 4) => {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += value(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  };
}

function atlasCanvas(): { canvas: HTMLCanvasElement; img: ImageData } {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = GRID * CELL;
  const g = canvas.getContext('2d')!;
  return { canvas, img: g.createImageData(canvas.width, canvas.height) };
}

/**
 * Write one cell with a per-pixel function returning [r,g,b,a] in 0..1.
 *
 * Alpha is tapered to zero over the last few pixels of the cell. Without that,
 * any shape that reaches the cell border (turbulent flame tongues do) gets cut
 * off by the quad edge and the particle shows a hard rectangular corner.
 */
function fillCell(
  img: ImageData, cell: number,
  f: (u: number, v: number) => [number, number, number, number],
) {
  const cx = (cell % GRID) * CELL;
  const cy = Math.floor(cell / GRID) * CELL;
  const BORDER = 0.06;
  const taper = (t: number) => Math.min(1, Math.min(t, 1 - t) / BORDER);
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const u0 = (x + 0.5) / CELL, v0 = (y + 0.5) / CELL;
      const edge = Math.max(0, taper(u0)) * Math.max(0, taper(v0));
      const [r, gg, b, a0] = f(u0, v0);
      const a = a0 * edge;
      const i = ((cy + y) * img.width + (cx + x)) * 4;
      img.data[i] = r * 255;
      img.data[i + 1] = gg * 255;
      img.data[i + 2] = b * 255;
      img.data[i + 3] = a * 255;
    }
  }
}

let additive: THREE.CanvasTexture | null = null;
let alpha: THREE.CanvasTexture | null = null;

/** fire, sparks and glows — drawn with additive blending */
export function getAdditiveAtlas(): THREE.CanvasTexture {
  if (additive) return additive;
  const { canvas, img } = atlasCanvas();
  const n = makeNoise(7);

  // --- fire flipbook: a teardrop mask eaten into by noise that scrolls upward,
  // so each frame is a plausible next instant of the same flame rather than a
  // fade of the previous one
  for (let f = 0; f < CELL_FIRE_N; f++) {
    const t = f / CELL_FIRE_N;
    fillCell(img, CELL_FIRE_0 + f, (u, v) => {
      // v runs downward (flipY is off), so the tip is at v = 0
      const dx = (u - 0.5) * (1.5 + 2.4 * (1 - v));   // waist narrows upward
      const body = 1 - Math.min(1, Math.hypot(dx, (v - 0.62) * 1.5) * 2.1);
      if (body <= 0) return [0, 0, 0, 0];
      // turbulence scrolls up and swirls as the flipbook plays
      const turb = n(u * 5 + t * 1.3, v * 5 - t * 6.0, 4);
      const d = Math.max(0, body * (0.55 + turb * 0.9) - 0.12);
      if (d <= 0) return [0, 0, 0, 0];
      // white-hot core -> yellow -> orange -> deep red at the fringe
      const heat = Math.min(1, d * 1.7);
      const r = Math.min(1, 0.35 + heat * 1.5);
      const gch = Math.min(1, heat * heat * 1.5);
      const b = Math.min(1, Math.max(0, heat - 0.62) * 2.3);
      return [r, gch, b, Math.min(1, d * 1.5)];
    });
  }

  // --- soft round glow: flashes, turbo cores, anything that wants a falloff
  fillCell(img, CELL_GLOW, (u, v) => {
    const r = Math.hypot(u - 0.5, v - 0.5) * 2;
    const a = Math.max(0, 1 - r);
    return [1, 1, 1, a * a * a];
  });

  // --- spark: a vertical streak, rotated to the velocity by the shader
  fillCell(img, CELL_SPARK, (u, v) => {
    const across = Math.abs(u - 0.5) * 2;
    const along = Math.abs(v - 0.5) * 2;
    const a = Math.max(0, 1 - across * 7) * Math.max(0, 1 - along * along);
    return [1, 0.92, 0.7, a];
  });

  // --- blast ring: a thin bright annulus that scales up as a shockwave
  fillCell(img, CELL_RING, (u, v) => {
    const r = Math.hypot(u - 0.5, v - 0.5) * 2;
    const a = Math.max(0, 1 - Math.abs(r - 0.78) * 9) * Math.max(0, 1 - r);
    return [1, 0.85, 0.6, a];
  });

  // --- ember: hot pinpoint with a faint halo
  fillCell(img, CELL_EMBER, (u, v) => {
    const r = Math.hypot(u - 0.5, v - 0.5) * 2;
    const core = Math.max(0, 1 - r * 5);
    const halo = Math.max(0, 1 - r) * 0.28;
    return [1, 0.75, 0.42, Math.min(1, core + halo)];
  });

  canvas.getContext('2d')!.putImageData(img, 0, 0);
  additive = new THREE.CanvasTexture(canvas);
  additive.colorSpace = THREE.SRGBColorSpace;
  // CanvasTexture defaults to flipY, which would make the shader's cell row
  // offset select the mirrored row of the grid — fire read the empty cells 12-15
  // while the "embers" were silently drawing fire frames
  additive.flipY = false;
  return additive;
}

/** smoke puffs — drawn with normal alpha blending, tinted per particle */
export function getAlphaAtlas(): THREE.CanvasTexture {
  if (alpha) return alpha;
  const { canvas, img } = atlasCanvas();
  const n = makeNoise(23);

  for (let f = 0; f < 16; f++) {
    // each cell is its own puff; the first 8 also read as a loose flipbook
    const seedU = (f % 4) * 3.1, seedV = Math.floor(f / 4) * 2.7;
    fillCell(img, f, (u, v) => {
      const r = Math.hypot(u - 0.5, v - 0.5) * 2;
      // billowing edge: push the silhouette in and out with low-frequency noise
      const lobe = n(u * 2.2 + seedU, v * 2.2 + seedV, 3);
      const edge = 0.82 + lobe * 0.42;
      if (r > edge) return [1, 1, 1, 0];
      const falloff = Math.pow(1 - r / edge, 1.35);
      // interior detail so the puff isn't a flat disc
      const detail = 0.62 + n(u * 6 + seedU, v * 6 + seedV, 4) * 0.55;
      const a = Math.min(1, falloff * detail * 0.95);
      // bake a little internal shading: lighter at the top-left of each puff
      const lit = 0.72 + (1 - v) * 0.3 + (1 - u) * 0.1;
      return [lit, lit, lit, a];
    });
  }

  canvas.getContext('2d')!.putImageData(img, 0, 0);
  alpha = new THREE.CanvasTexture(canvas);
  alpha.colorSpace = THREE.SRGBColorSpace;
  alpha.flipY = false;   // see getAdditiveAtlas
  return alpha;
}

export const ATLAS_GRID = GRID;
