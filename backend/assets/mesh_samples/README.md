# Web mesh samples

Open **Files → Sample meshes** in 6B. Five local GLB originals and their
interactive geometry previews are included; browsing them does not create tasks,
start provider runs, or require an internet connection. The preview includes
author, source, license, dimensions and checksum information. Original GLB
downloads preserve textures and materials; the viewer displays shaded geometry.

All five assets declare **CC0 1.0** in their upstream notices, retained as
`SOURCE.md` inside each model directory. Sources are pinned to Khronos
glTF-Sample-Assets commit `8f492390ddc7a2ae221a1369ef560589cf8c70fb`.

| Model | Upstream credit | Parts | Triangles | License/source notice |
| --- | --- | ---: | ---: | --- |
| Avocado | Microsoft | 1 | 682 | [Upstream notice](https://github.com/KhronosGroup/glTF-Sample-Assets/blob/8f492390ddc7a2ae221a1369ef560589cf8c70fb/Models/Avocado/README.md) |
| Water bottle | Microsoft | 1 | 4,510 | [Upstream notice](https://github.com/KhronosGroup/glTF-Sample-Assets/blob/8f492390ddc7a2ae221a1369ef560589cf8c70fb/Models/WaterBottle/README.md) |
| Lantern | Microsoft / sbtron; Frank Galligan | 3 | 5,394 | [Upstream notice](https://github.com/KhronosGroup/glTF-Sample-Assets/blob/8f492390ddc7a2ae221a1369ef560589cf8c70fb/Models/Lantern/README.md) |
| Radio (BoomBox) | Microsoft | 1 | 6,036 | [Upstream notice](https://github.com/KhronosGroup/glTF-Sample-Assets/blob/8f492390ddc7a2ae221a1369ef560589cf8c70fb/Models/BoomBox/README.md) |
| Toy car scene | Guido Odendahl; Eric Chadwick | 3 | 108,936 | [Upstream notice](https://github.com/KhronosGroup/glTF-Sample-Assets/blob/8f492390ddc7a2ae221a1369ef560589cf8c70fb/Models/ToyCar/README.md) |

Preview generation applies scene-instance world transforms, converts metres to
millimetres, and rotates glTF Y-up into Z-up, mapping source +Z front to the
viewer's +Y front. This preserves handedness, scale and instance placement.
See the [glTF coordinate-system specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#coordinate-system-and-units).
Preview conversion does not establish solid CAD validity or printability.

To rebuild previews from the checked-in originals, run from the repository root:

```sh
.venv/bin/python backend/scripts/prepare_mesh_samples.py
```

Add `--download` only when intentionally fetching the pinned upstream originals
and notices. Each download is limited to 12 MiB. Conversion rejects nonfinite
coordinates, invalid triangle indices, empty meshes and previews exceeding
256 parts, 500,000 vertices or 250,000 triangles. This is a maintainer preparation
script, not an arbitrary-URL import endpoint. Runtime sample routes use exact
catalogue IDs, remain behind the normal local API boundary and verify SHA-256
before serving files. Restart the backend after regenerating the catalogue.
