"""
Cut the two wheels out of the generated REAPER body so the game can mount
spinning ones.

Same problem and the same solution as tools/blender/autocut_wheels.py, but that
script assumes a CAR: four wheels, found on an outboard slab (|y| > 0.55*track).
A motorcycle has two wheels on the centreline, so none of its tests apply.

Method, which is the part worth keeping:
  * the only geometry touching the ground is tyre, so the CONTACT BAND
    (z < zmin + 0.1) isolates the wheels from everything else;
  * clustering that band along the length axis gives the two axle positions
    without any hand-measuring;
  * a wheel is circular in the length/height plane, so deleting verts within a
    radius of the axle centre - across the full width - removes the wheel and
    nothing else.

Do NOT boolean these. Phase 3.3 established that boolean DIFFERENCE inverts on
these shells (not watertight, inconsistent winding), keeping the knife and
deleting the car. Deleting vertices is unambiguous.

Writes the measured axle positions to stdout so render/reaper.ts can mount its
wheels where the originals were, instead of guessing.
"""
import bpy, bmesh, json, math

SRC = '/Users/ram.a/Desktop/WebGame/public/models/reaper-bike.glb'
OUT = '/Users/ram.a/Desktop/WebGame/public/models/reaper-bike.glb'
REPORT = '/tmp/claude-503/cut_report.json'
CONTACT = 0.10      # how far above the lowest point still counts as tyre
PAD = 1.12          # cut a little proud of the measured radius

def reset():
    try:
        if bpy.context.view_layer.objects.active and bpy.context.object.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
    except Exception:
        pass
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)

reset()
bpy.ops.import_scene.gltf(filepath=SRC)
ob = max([o for o in bpy.data.objects if o.type == 'MESH'], key=lambda o: len(o.data.vertices))
mw = ob.matrix_world
co = [mw @ v.co for v in ob.data.vertices]
zmin = min(v.z for v in co)

# WHICH AXIS IS THE LENGTH? Do not assume. The first bike came in with its
# length on Y; the second did not, and the gap search then found no wheelbase
# (widest gap 0.0116) and the cut nearly deleted the whole machine.
spanx = max(v.x for v in co) - min(v.x for v in co)
spany = max(v.y for v in co) - min(v.y for v in co)
LONG = 'x' if spanx > spany else 'y'
along = (lambda v: v.x) if LONG == 'x' else (lambda v: v.y)

# --- 1. find the axles from the contact band ---
band = [v for v in co if v.z < zmin + CONTACT]
ys = sorted(along(v) for v in band)
# Split the band at its widest gap: that gap is the wheelbase.
#
# SANITY CHECK, and it matters: on one model the band did not separate at all
# (widest gap 0.0116 on a 1.5m bike), so both "axles" landed on top of each
# other at y=0 with a radius that covered the whole machine, and the cut deleted
# 36,411 of 36,484 vertices. A wheelbase is never a rounding error — if the gap
# is not a real fraction of the length, there is nothing safe to cut.
span = max(ys) - min(ys)
gap_i, gap = 0, 0
for i in range(1, len(ys)):
    if ys[i] - ys[i - 1] > gap:
        gap, gap_i = ys[i] - ys[i - 1], i
if gap < span * 0.12:
    raise SystemExit(
        'REFUSING TO CUT: no wheelbase gap found in the contact band '
        f'(widest {gap:.4f} over a span of {span:.3f}). The wheels are not '
        'separable this way on this mesh.')
groups = [ys[:gap_i], ys[gap_i:]]
axles = []
for grp in groups:
    cy = sum(grp) / len(grp)
    # radius: the wheel reaches from the ground up to its own top, so half the
    # height of the geometry sitting directly over this axle
    over = [v for v in co if abs(along(v) - cy) < 0.10]
    r = (max(v.z for v in over) - zmin) / 2 if over else 0.2
    # the estimate reads the tallest thing over the axle, which may be fender or
    # tank rather than tyre; a wheel is never more than a third of the length
    r = min(r, span * 0.33)
    axles.append({'y': cy, 'r': r, 'cz': zmin + r, 'n': len(grp)})

report = {'zmin': round(zmin, 4), 'lengthAxis': LONG, 'wheelbaseGap': round(gap, 4),
          'axles': [{k: round(v, 4) for k, v in a.items()} for a in axles]}

# --- 2. delete every vertex inside either wheel ---
bpy.context.view_layer.objects.active = ob
bpy.ops.object.mode_set(mode='EDIT')
bm = bmesh.from_edit_mesh(ob.data)
bm.verts.ensure_lookup_table()
doomed = []
for v in bm.verts:
    w = mw @ v.co
    for a in axles:
        if math.hypot(along(w) - a['y'], w.z - a['cz']) < a['r'] * PAD:
            doomed.append(v)
            break
report['verticesBefore'] = len(bm.verts)
report['verticesCut'] = len(doomed)
bmesh.ops.delete(bm, geom=doomed, context='VERTS')
bmesh.update_edit_mesh(ob.data)
bpy.ops.object.mode_set(mode='OBJECT')
report['verticesAfter'] = len(ob.data.vertices)

bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=False)
open(REPORT, 'w').write(json.dumps(report))
