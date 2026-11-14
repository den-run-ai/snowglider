# SnowGlider PR #483 evidence

Evidence-only branch for https://github.com/den-run-ai/snowglider/pull/483. Do not merge this branch into main. These media files do not ship in the game.

## Revisions

- BASE: 5738d94e8b3c6214e3c005256b802570c56cdbec
- Production runtime: 9660fc069c86b4a777f978a4b33e030c93922e8f
- Captured/tested checkout: 2cb650ea898c6ba6af8b606061fe9e83590c7248; intervening changes are tests only.

## Visuals

The desktop follow and orbit boards compare actual production WebGL renders, with unchanged seed, prescribed replay, quality and camera inputs. They add external labels and WebP compression only. The phone image is Chromium viewport/touch emulation. All scenes use actual EZ trees (201 branch batches), low graphics tier and default shared wind. These are rendering fixtures, not proof of a completed autonomous ski run or physical-phone performance.

- [Desktop follow](wind-evidence/desktop-follow-before-after.webp)
- [Crosswind orbit](wind-evidence/crosswind-detail-before-after.webp)
- [Phone follow](wind-evidence/phone-follow-after.webp)
- [Capture provenance and original-image hashes](wind-evidence/visual-capture-manifest.json)

The optional full-scene animation was stopped after the local software GPU exited with code 9. No animation result is claimed. Original-image hashes refer to source captures; compact boards are the committed visual deliverables. The PR's Rendering review workflow retains the full pinned-browser BASE/HEAD evidence separately.

## Sound

The recordings use the actual production Sfx modules in Chromium OfflineAudioContext. Timeline: 0–3s calm, 3–6s open gust, 6–10s headwind, 10–14s tailwind, 14–18s forest from left, 18–22s camera reversed, 22–24s mute. No music or microphone input.

- [Before audio](wind-evidence/wind-audio-before.m4a)
- [After audio](wind-evidence/wind-audio-after.m4a)
- [After audio with visual timeline](wind-evidence/wind-audio-after.mp4)
- [Spectrogram and RMS comparison](wind-evidence/wind-audio-comparison.webp)
- [Exact source provenance and metrics](wind-evidence/wind-audio-metrics.json)
- [Audio artifact hashes](wind-evidence/wind-audio-manifest.json)

The headwind/tailwind segments differ by 7.6 dB RMS; camera rotation reverses the stereo bias; peak amplitude is 0.246, with zero clipped samples and exact silence while muted. This does not establish physical iPhone/Android audio acceptance (#249). The audio manifest also records the source WAV and full-resolution plot hashes used to make the committed compressed previews.

## GPU qualification

The permanent test in tests/e2e/wind-rendering.spec.ts executes actual production tree GLSL using WebGL2 transform feedback. Eleven material variants pass; maximum normal error against independently sampled deformed geometry is 0.058532 degrees, compared with 1.245510 degrees using the old undeformed normal. All outputs are finite and gl.getError() is zero.

[GPU metrics](wind-evidence/tree-wind-gpu-metrics.json) · [Raw Playwright report](wind-evidence/gpu-test-report.json)

Capture/plot scripts are included for provenance. Their absolute checkout paths and installed browser path record this capture environment; update those paths to reproduce using the exact revisions above.
