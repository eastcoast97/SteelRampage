"""
Auto-detect and remove the wheels from an AI-generated vehicle GLB, leaving
wheel wells for the game's steer/spin rig to mount into.

Why this is not a boolean
-------------------------
Meshy/Tripo image-to-3D output is a single FUSED shell (verified: welding by
position gives ONE connected component), so loose-part separation can never
work. The obvious alternative — differencing cylinders out — does NOT work
either: these shells are not watertight and their winding is inconsistent, so
the EXACT solver decides the outside is the inside and KEEPS the knife instead
of subtracting it. Measured on juggernaut_raw: 23882 -> 2989 tris with the car
gone and the cylinder left behind; a merge-by-distance + recalc-normals pass
improved it but still inverted on two of the four wheels (bbox reached the
knife's outer end at y -0.65, outside the body's -0.50). The MANIFOLD solver
simply refuses and returns the input unchanged.

So we delete geometry directly: select every vertex inside the wheel volume and
dissolve it. That depends on no CSG robustness at all, and the resulting open
well is invisible in game because the mounted wheel fills it.

Geometry notes
--------------
  * glTF is +Y-up; Blender's importer converts to +Z-up. Inside this script UP
    IS Z, length is X, track is Y — even though the same mesh is Y-up in the
    browser.
  * The contact band (lowest ~12% of verts) clusters into two X peaks (axles)
    and two Y peaks (sides); the mean of each sign gives the hub centres.
  * Tyre radius is a fixed fraction of half-length, NOT measured. Measuring it
    from the outboard slab was tried and overshoots badly (0.43-0.48 against a
    true ~0.25) because that slab holds the whole flank — skirts, doors, fender
    — not just the wheel. 0.26 is the value proven on the hellcat cut, and a
    sweep puts it at 21% of verts removed on juggernaut and 31% on scorch,
    which is the right order for four dense tyres.

Reads IN_PATH / OUT_PATH globals injected by the caller; prints a JSON report.
"""
import bpy
import bmesh
import json

# the outboard slab starts here, as a fraction of the measured track; inboard of
# it is chassis floor we must keep
Y_IN_FRAC = 0.55
# tyre radius as a fraction of the body's half-length (see module docstring)
R_FRAC = 0.26


def _reset():
    try:
        if bpy.context.view_layer.objects.active and bpy.context.object.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
    except Exception:
        pass
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)


def _peaks(vals):
    """split a 1-D sample into its negative and positive cluster centres"""
    neg = [v for v in vals if v < 0]
    pos = [v for v in vals if v >= 0]
    return (sum(neg) / len(neg) if neg else -0.5,
            sum(pos) / len(pos) if pos else 0.5)


def cut(in_path, out_path):
    _reset()
    bpy.ops.import_scene.gltf(filepath=in_path)
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    car = max(meshes, key=lambda o: len(o.data.polygons))
    car.name = "CarBody"
    bpy.context.view_layer.objects.active = car
    car.select_set(True)

    co = [v.co for v in car.data.vertices]
    zmin = min(c.z for c in co)
    zmax = max(c.z for c in co)
    height = zmax - zmin
    half_len = (max(c.x for c in co) - min(c.x for c in co)) / 2
    half_wid = max(abs(min(c.y for c in co)), abs(max(c.y for c in co)))

    low = [c for c in co if c.z < zmin + height * 0.12]
    ax_neg, ax_pos = _peaks([c.x for c in low])     # rear / front axle
    sy_neg, sy_pos = _peaks([c.y for c in low])     # left / right side
    track = max(abs(sy_neg), abs(sy_pos))
    y_in = track * Y_IN_FRAC

    radius = half_len * R_FRAC
    z_hub = zmin + radius * 0.95          # tyre sits tangent to the ground
    axles = (ax_neg, ax_pos)

    bm = bmesh.new()
    bm.from_mesh(car.data)
    doomed = []
    for v in bm.verts:
        if abs(v.co.y) <= y_in:
            continue                                  # chassis floor — keep
        for ax in axles:
            if (v.co.x - ax) ** 2 + (v.co.z - z_hub) ** 2 < radius * radius:
                doomed.append(v)
                break
    before = len(bm.faces)
    bmesh.ops.delete(bm, geom=doomed, context='VERTS')
    bm.to_mesh(car.data)
    removed = before - len(bm.faces)
    bm.free()
    car.data.update()

    for o in bpy.data.objects:
        o.select_set(o is car)
    bpy.context.view_layer.objects.active = car
    bpy.ops.export_scene.gltf(filepath=out_path, export_format='GLB',
                              use_selection=True, export_apply=True)

    return {
        "axles": [round(ax_neg, 3), round(ax_pos, 3)],
        "radius": round(radius, 3),
        "track": round(track, 3), "slabFrom": round(y_in, 3),
        "halfWidth": round(half_wid, 3),
        "trisBefore": before, "trisAfter": len(car.data.polygons),
        "removedPct": round(100 * removed / before, 1),
        # hub frame for the game rig, back in glTF axes (Blender x,y,z -> x,z,-y)
        "hubs": {"axleX": [round(ax_neg, 3), round(ax_pos, 3)],
                 "hubHeightY": round(z_hub - zmin, 3),
                 "trackZ": round(track, 3)},
    }


print(json.dumps(cut(IN_PATH, OUT_PATH)))   # noqa: F821 - injected by caller
