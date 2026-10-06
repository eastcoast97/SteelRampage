import { STREETS, ARCS, ROUNDABOUT, STREETS_DOCKS, ARENA_HALF } from '../game/arena';

/**
 * The arena's street layout, drawn to a canvas.
 *
 * This is the radar's underlay AND the map on the loading screen. It was the
 * radar's private business until the loading screen wanted the same picture; a
 * second copy would have been two drawings of one map, drifting apart the first
 * time a street moved. The layout tables in arena.ts are already the single
 * source for the roads themselves — this is the single source for how they are
 * drawn.
 *
 * `size` is the canvas edge in pixels and always covers the whole arena, so the
 * caller picks the resolution and nothing here needs to know about radar range.
 */
export function drawArenaMap(size: number, arenaIdx = 0): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const s = size / (ARENA_HALF * 2);          // world metres → px
  const px = (w: number) => w * s + size / 2;

  // ground wash, so streets read as cut INTO something rather than floating
  g.fillStyle = 'rgba(26, 32, 40, 0.55)';
  g.fillRect(0, 0, size, size);

  const streets = arenaIdx === 1 ? STREETS_DOCKS : STREETS;
  // two passes: a dark casing under a lighter fill is what makes a road legible
  // at this size — a single flat stroke mushes together at junctions
  for (const pass of [
    { col: 'rgba(10, 14, 20, 0.85)', pad: 2.5 },
    { col: 'rgba(150, 170, 190, 0.5)', pad: 0 },
  ]) {
    g.strokeStyle = pass.col;
    g.lineCap = 'round';
    for (const [x0, z0, x1, z1, w] of streets) {
      g.lineWidth = w * s + pass.pad;
      g.beginPath();
      g.moveTo(px(x0), px(z0));
      g.lineTo(px(x1), px(z1));
      g.stroke();
    }
    if (arenaIdx !== 1) {
      for (const [cx, cz, r, th0, thLen, w] of ARCS) {
        g.lineWidth = w * s + pass.pad;
        g.beginPath();
        g.arc(px(cx), px(cz), r * s, th0, th0 + thLen);
        g.stroke();
      }
      g.lineWidth = ROUNDABOUT.w * s + pass.pad;
      g.beginPath();
      g.arc(px(0), px(0), ROUNDABOUT.r * s, 0, Math.PI * 2);
      g.stroke();
    }
  }

  if (arenaIdx === 1) {
    g.fillStyle = 'rgba(32, 86, 150, 0.5)';
    g.fillRect(px(140), px(-ARENA_HALF), 20 * s, ARENA_HALF * 2 * s);
    g.strokeStyle = 'rgba(90, 210, 255, 0.55)';
    g.lineWidth = 2;
    g.strokeRect(px(32), px(-75), 24 * s, 60 * s);
    g.strokeRect(px(32), px(15), 24 * s, 60 * s);
    return c;
  }

  // roundabout island
  g.fillStyle = 'rgba(214, 180, 120, 0.4)';
  g.beginPath();
  g.arc(px(0), px(0), ROUNDABOUT.islandR * s, 0, Math.PI * 2);
  g.fill();
  // diagonal tunnels — cyan, matching their neon
  g.strokeStyle = 'rgba(90, 210, 255, 0.5)';
  g.lineWidth = 14 * s;
  for (const d of [1, -1]) {
    g.beginPath();
    g.moveTo(px(d * 28), px(-d * 28));
    g.lineTo(px(d * 63), px(-d * 63));
    g.stroke();
  }
  // skyway — orange, and dashed because it is ABOVE you, not a road you can
  // turn onto from here
  g.strokeStyle = 'rgba(255, 140, 50, 0.65)';
  g.lineWidth = 9 * s;
  g.setLineDash([10, 7]);
  g.beginPath();
  g.moveTo(px(-90), px(120));
  g.lineTo(px(90), px(120));
  g.stroke();
  g.setLineDash([]);
  return c;
}

/** landmarks worth calling out on the big loading-screen map */
export const ARENA_BRIEF: { name: string; blurb: string; marks: [number, number, string][] }[] = [
  {
    name: 'SUNBAKED JUNCTION',
    blurb: 'Small-town crossroads. A roundabout at the centre with a clock tower you can bring down, two neon tunnels on the diagonal, and a skyway over the north side.',
    marks: [
      [0, 0, 'CLOCK TOWER'],
      [45, -45, 'TUNNEL'],
      [-45, 45, 'TUNNEL'],
      [-62, 120, 'SKYWAY'],
      [62, 112, 'GAS STATION'],
    ],
  },
  {
    name: 'NEON DOCKS',
    blurb: 'Night harbour. Drive-through warehouses, container alleys, a refinery that goes up when you shoot it, and the colossus standing over the east road.',
    marks: [
      [44, -45, 'WAREHOUSE'],
      [44, 45, 'WAREHOUSE'],
      [95, -15, 'COLOSSUS'],
      [0, 120, 'SKYWAY'],
      [140, 0, 'HARBOUR'],
    ],
  },
];
