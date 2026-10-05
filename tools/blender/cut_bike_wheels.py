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

SRC = '/Users/ram.a/Desktop/WebGame/public/models/reaper-ai.glb'
OUT = '/Users/ram.a/Desktop/WebGame/public/models/reaper-ai.glb'
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

# --- 1. find the axles from the contact band ---
band = [v for v in co if v.z < zmin + CONTACT]
ys = sorted(v.y for v in band)
# split the band at its widest gap: that gap is the wheelbase
gap_i, gap = 0, 0
for i in range(1, len(ys)):
    if ys[i] - ys[i - 1] > gap:
        gap, gap_i = ys[i] - ys[i - 1], i
groups = [ys[:gap_i], ys[gap_i:]]
axles = []
for grp in groups:
    cy = sum(grp) / len(grp)
    # radius: the wheel reaches from the ground up to its own top, so half the
    # height of the geometry sitting directly over this axle
    over = [v for v in co if abs(v.y - cy) < 0.10]
    r = (max(v.z for v in over) - zmin) / 2 if over else 0.2
    axles.append({'y': cy, 'r': r, 'cz': zmin + r, 'n': len(grp)})

report = {'zmin': round(zmin, 4), 'wheelbaseGap': round(gap, 4),
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
        if math.hypot(w.y - a['y'], w.z - a['cz']) < a['r'] * PAD:
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
