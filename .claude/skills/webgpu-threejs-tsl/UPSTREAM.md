# Provenance

Vendored from [dgreenheck/webgpu-claude-skill](https://github.com/dgreenheck/webgpu-claude-skill)
(`skills/webgpu-threejs-tsl/`), MIT License (per the upstream README; code examples derived from
[three.js](https://github.com/mrdoob/three.js), also MIT).

- Upstream base commit: `af2319bd01bb7cc881267a9ef42cafdaf5e9029d` (2026-04-10)
- Skill's stated target: three.js r183+; verified against r183–r185

## Local corrections applied on top of upstream

Every API identifier and import path in the skill was machine-validated against the real
export tables and `examples/jsm` file trees of `three@0.183.0` and `three@0.185.0`
(530 checks). 11 errors were found upstream and are fixed in this vendored copy:

- `docs/post-processing.md` — 7 wrong `three/addons/tsl/display/*` import paths:
  `MotionBlur.js` (not `MotionBlurNode.js`), `GTAONode.js` (not `AmbientOcclusionNode.js`),
  `Sepia.js`, `RetroPassNode.js`, `boxBlur.js`, `hashBlur.js`; `AnamorphicNode.js` was
  removed in r184 (replaced with a version note).
- Phantom `three/tsl` exports: `atan2` → `atan(y, x)`; `envMap`/`material.envMapNode` →
  `material.envNode` (+ missing `lights` import); `texture3DLoad`/`texture3DLevel` → `texture3D`.
- `REFERENCE.md`: softened "RenderPipeline replaced PostProcessing in r183"
  (`PostProcessing` still exists, extends `RenderPipeline`, and is not deprecated).
- `SKILL.md`: defined `viewDir` in the fresnel `Fn` example (was undefined).

These fixes have also been offered upstream. When refreshing this copy from upstream,
re-verify identifiers before overwriting (upstream may or may not have taken the fixes),
and re-check import paths against the `three` version pinned in `package.json`.
