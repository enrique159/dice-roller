# Dice models (GLB/GLTF)

Place your numbered dice models here to be used by the app automatically.

Supported files (exact filenames):
- d4.glb
- d6.glb
- d8.glb
- d10.glb
- d12.glb
- d20.glb
- d100.glb (optional, you can omit this and reuse d10 visually)

Notes and recommendations:
- Units: meters. The loader normalizes overall size to ~1.2 units on the largest dimension.
- Origin: center your model at its geometric center. The app adds a ground at y=0.
- Orientation: any is fine; the app spins dice during roll. If you want a canonical up-face at rest, orient +Y as the top face.
- Meshes should have materials/textures with the numbers already baked or UV-mapped.
- Keep polycount reasonable for performance (e.g., <10k tris per die).

Folder is served statically by Vite from `public/`, so paths are:
- `/models/dice/d6.glb` (etc.)

If a model is missing, the app falls back to a primitive mesh. The d6 still shows numbered faces via procedural Canvas textures.
