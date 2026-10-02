import bpy, math

car = bpy.data.objects["CarBody"]
bpy.context.view_layer.objects.active = car

# Wheel positions derived from a vertex histogram of the lowest band:
# axles at x = +/-0.55, sides at y = +/-0.36, tyres resting on zmin = -0.49.
R = 0.245                 # cutter radius — slightly over the tyre
ZC = -0.49 + 0.21         # wheel centre height

for sx in (-1, 1):
    for sy in (-1, 1):
        bpy.ops.mesh.primitive_cylinder_add(
            vertices=24, radius=R, depth=0.40,
            location=(sx * 0.55, sy * 0.37, ZC),
            rotation=(math.pi / 2, 0, 0),      # axis along Y (the axle)
        )
        cut = bpy.context.active_object
        cut.name = "WheelCutter"
        m = car.modifiers.new("wheelcut", 'BOOLEAN')
        m.operation = 'DIFFERENCE'
        m.object = cut
        m.solver = 'EXACT'
        bpy.context.view_layer.objects.active = car
        bpy.ops.object.modifier_apply(modifier=m.name)
        bpy.data.objects.remove(cut, do_unlink=True)

OUT = "/private/tmp/claude-503/-Users-ram-a-Desktop-WebGame/a3a82f4e-5f81-422e-a302-9361ae71115f/scratchpad/hellcat_body_nowheels.glb"
for o in bpy.data.objects:
    o.select_set(o is car)
bpy.context.view_layer.objects.active = car
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_apply=True)
print({"tris_after_cut": len(car.data.polygons), "exported": OUT.split('/')[-1]})
