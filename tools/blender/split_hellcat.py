import bpy

# Blender may be sitting in Edit Mode (operators then fail with a context poll
# error) — force Object Mode, then clear the scene via the data API rather than
# bpy.ops.object.select_all, which needs a valid operator context.
try:
    if bpy.context.view_layer.objects.active and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
except Exception:
    pass
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)

SRC = "/private/tmp/claude-503/-Users-ram-a-Desktop-WebGame/a3a82f4e-5f81-422e-a302-9361ae71115f/scratchpad/hellcat_ai.glb"
bpy.ops.import_scene.gltf(filepath=SRC)
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
car = meshes[0]
car.name = "CarBody"
bpy.context.view_layer.objects.active = car

bb = [v[:] for v in car.bound_box]
xs = [v[0] for v in bb]; ys = [v[1] for v in bb]; zs = [v[2] for v in bb]
print({"meshes": len(meshes),
       "dims": tuple(round(v, 3) for v in car.dimensions),
       "x": (round(min(xs), 2), round(max(xs), 2)),
       "y": (round(min(ys), 2), round(max(ys), 2)),
       "z": (round(min(zs), 2), round(max(zs), 2)),
       "tris": len(car.data.polygons)})
