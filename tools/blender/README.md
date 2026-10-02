# Blender tooling

Blender is driven over the **BlenderMCP add-on's raw socket on `localhost:9876`**,
not the `mcp__Blender__*` tools (those time out — see docs/BLENDER.md).

`send.py <script.py>` pipes a Python file into the running Blender instance:

```bash
python3 tools/blender/send.py tools/blender/arena4.py
```

Blender must be running with the add-on connected (N-panel → BlenderMCP → Connect).

## IMPORTANT — keep generator scripts HERE, not in /tmp

The original `arena4.py` / `arena5.py` / car generators were written to `/tmp/bl/`
and were lost when macOS cleared the temp directory. The exported GLBs in
`public/models/` still work, but the sources that produced them are gone. Any new
generator script belongs in this directory and gets committed.
