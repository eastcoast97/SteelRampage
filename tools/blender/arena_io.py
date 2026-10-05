"""
Load, audit and re-export a game arena GLB in Blender.

The parametric generators that originally produced `arena.glb` and
`arena-docks.glb` were written to /tmp and lost to macOS temp cleanup, so for
several phases the arenas were effectively frozen: the committed GLBs worked
but nothing could be changed. This restores editing by round-tripping the GLB
itself — import, move/add/delete whatever you like in Blender, export back over
the same file.

Usage from the socket helper (see docs/BLENDER.md — the mcp__Blender__* tools
time out, talk to localhost:9876 instead):

    exec(open('tools/blender/arena_io.py').read())
    load(TOWN)                 # or DOCKS
    audit()                    # marker counts + naming problems
    ...edit...
    save(TOWN)                 # audits first, refuses to write if it fails

What the game needs from the file
---------------------------------
`consumeArenaGLB()` in src/game/arena.ts routes objects purely by NAME prefix:

    COL_*              collision proxy -> Rapier collider, mesh is stripped
    SPAWN_<n>          vehicle spawn point (Empty)
    PICKUP_<type>_<n>  pickup socket; <type> must be a PickupType (Empty)
    BARREL_<n>         explosive barrel (Empty)
    PUMP_<n>           gas pump: a super-barrel, 1.6x damage (Empty)
    BOOST_<n>          boost pad; the MESH's extents become the pad rect
    PED_<n>            pedestrian zone; the MESH's extents become the rect
    anything else      plain scenery, rendered as-is

Markers are Empties and carry no geometry, so they must survive the export as
nodes — that is the single most fragile part of the round trip and `audit()`
checks it explicitly.

Axis note: Blender +Y maps to game -Z. Positions printed by `audit()` are in
GAME coordinates so they can be compared against arena.ts directly.
"""
import bpy
import json
import os
import re
from collections import Counter

MODELS = "/Users/ram.a/Desktop/WebGame/public/models"
TOWN = os.path.join(MODELS, "arena.glb")
DOCKS = os.path.join(MODELS, "arena-docks.glb")

# must match PICKUP_TYPE_ORDER in src/game/pickups.ts
PICKUP_TYPES = {"missiles", "health", "turbo", "mines", "special", "shield", "overdrive", "nuke"}

MARKER_PREFIXES = ("SPAWN_", "PICKUP_", "BARREL_", "PUMP_")
RECT_PREFIXES = ("BOOST_", "PED_")


def _reset():
    try:
        if bpy.context.view_layer.objects.active and bpy.context.object.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
    except Exception:
        pass
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)


def load(path=TOWN):
    """Wipe the scene and import an arena GLB."""
    _reset()
    bpy.ops.import_scene.gltf(filepath=path)
    return audit(quiet=True)


def game_pos(o):
    """World position in GAME axes: Blender (x, y, z) -> game (x, z, -y)."""
    w = o.matrix_world.translation
    return (round(w.x, 2), round(w.z, 2), round(-w.y, 2))


def audit(quiet=False):
    """Count markers and flag anything the game loader would silently drop."""
    objs = list(bpy.data.objects)
    counts = Counter()
    problems = []

    for o in objs:
        n = o.name
        if n.startswith("COL_"):
            counts["COL"] += 1
            if o.type != 'MESH':
                problems.append(f"{n}: collision proxy is {o.type}, must be MESH")
        elif n.startswith(MARKER_PREFIXES):
            counts[n.split("_")[0]] += 1
            if n.startswith("PICKUP_"):
                parts = n.split("_")
                if len(parts) < 3 or parts[1] not in PICKUP_TYPES:
                    problems.append(f"{n}: pickup type must be one of {sorted(PICKUP_TYPES)}")
        elif n.startswith(RECT_PREFIXES):
            counts[n.split("_")[0]] += 1
            if o.type != 'MESH':
                problems.append(f"{n}: rect marker is {o.type}, the game reads its mesh extents")
        else:
            counts["scenery"] += 1

    # Blender appends .001 to duplicate names; the game would then see
    # "SPAWN_3.001" which does not match its prefix+index parsing cleanly
    dupes = [o.name for o in objs if re.search(r"\.\d{3}$", o.name)]
    if dupes:
        problems.append(f"{len(dupes)} duplicate-suffixed names (e.g. {dupes[:3]}) — rename before export")

    if counts["SPAWN"] < 6:
        problems.append(f"only {counts['SPAWN']} spawn points; the game fills 6 seats")

    report = {
        "total": len(objs),
        "counts": dict(sorted(counts.items())),
        "problems": problems,
    }
    if not quiet:
        print(json.dumps(report, indent=2))
    return report


def marker_table():
    """Every gameplay marker with its GAME-space position, for diffing."""
    rows = []
    for o in sorted(bpy.data.objects, key=lambda o: o.name):
        if o.name.startswith(MARKER_PREFIXES + RECT_PREFIXES):
            rows.append({"name": o.name, "pos": game_pos(o)})
    return rows


def save(path=TOWN, force=False):
    """
    Export every object back to a GLB the game can load.

    Exports the whole scene rather than a selection: `use_selection` has bitten
    this project before by quietly dropping the marker Empties, which have no
    geometry to make their absence obvious until a match starts with no spawns.
    """
    report = audit(quiet=True)
    if report["problems"] and not force:
        print(json.dumps({"refused": True, **report}, indent=2))
        return report

    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=False,
        export_apply=True,
        export_extras=False,
        export_cameras=False,
        export_lights=False,
    )
    size = os.path.getsize(path)
    print(json.dumps({"wrote": path, "bytes": size, **report}))
    return report
