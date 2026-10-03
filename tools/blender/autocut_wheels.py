"""
Auto-detect and boolean-cut the wheels out of an AI-generated vehicle GLB.

Meshy/Tripo image-to-3D output is a single FUSED shell (verified: welding by
position gives ONE connected component), so loose-part separation can never
work. Instead we find the wheels statistically: the lowest band of vertices is
the tyre contact patch, which clusters into two X peaks (axles) and two Y peaks
(sides). Cylinders at those four positions get boolean-differenced out, leaving
real wheel wells for the game's steer/spin rig.

Reads IN_PATH / OUT_PATH globals injected by the caller.
"""
import bpy

try:
    if bpy.context.view_layer.objects.active and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
except Exception:
    pass
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)

bpy.ops.import_scene.gltf(filepath=IN_PATH)
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
car = max(meshes, key=lambda o: len(o.data.polygons))
car.name = "CarBody"
bpy.context.view_layer.objects.active = car

co = [v.co for v in car.data.vertices]
zmin = min(c.z for c in co)
zmax = max(c.z for c in co)
low = [c for c in co if c.z < zmin + (zmax - zmin) * 0.12]

def peaks(vals):
    """split a 1-D sample into its negative and positive cluster centres"""
    neg = [v for v in vals if v < 0]
    pos = [v for v in vals if v >= 0]
    return (sum(neg) / len(neg) if neg else -0.5,
            sum(pos) / len(pos) if pos else 0.5)

ax_neg, ax_pos = peaks([c.x for c in low])     # front / rear axle
sy_neg, sy_pos = peaks([c.y for c in low])     # left / right side

half_len = (max(c.x for c in co) - min(c.x for c in co)) / 2
R = half_len * 0.26                             # tyre radius ~26% of half-length
ZC = zmin + R * 0.92
track = max(abs(sy_neg), abs(sy_pos))

import math
for ax in (ax_neg, ax_pos):
    for sy in (sy_neg, sy_pos):
        bpy.ops.mesh.primitive_cylinder_add(
            vertices=24, radius=R, depth=abs(track) * 1.1,
            location=(ax, sy, ZC), rotation=(math.pi / 2, 0, 0),
        )
        cut = bpy.context.active_object
        m = car.modifiers.new("wheelcut", 'BOOLEAN')
        m.operation = 'DIFFERENCE'; m.object = cut; m.solver = 'EXACT'
        bpy.context.view_layer.objects.active = car
        bpy.ops.object.modifier_apply(modifier=m.name)
        bpy.data.objects.remove(cut, do_unlink=True)

for o in bpy.data.objects:
    o.select_set(o is car)
bpy.context.view_layer.objects.active = car
bpy.ops.export_scene.gltf(filepath=OUT_PATH, export_format='GLB',
                          use_selection=True, export_apply=True)
print({"axles": (round(ax_neg, 2), round(ax_pos, 2)),
       "sides": (round(sy_neg, 2), round(sy_pos, 2)),
       "R": round(R, 3), "tris": len(car.data.polygons)})
