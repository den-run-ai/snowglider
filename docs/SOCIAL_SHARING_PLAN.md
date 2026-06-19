# Social Sharing Implementation Plan

This is a planning-only proposal for adding lightweight social sharing to the
finish result flow. It does not implement the feature yet.

## Goal

Let players share a completed SnowGlider run without requiring sign-in, a backend
endpoint, or a platform-specific SDK.

## Proposed Approach

1. Add a small `src/share.ts` module with:
   - `buildResultShareData(time, isNewBest)` for deterministic share copy.
   - `shareResult(data)` for native sharing plus fallback handling.
2. Use the Web Share API when `navigator.share` is available and the call is
   triggered by the result-screen button.
3. Fall back to `navigator.clipboard.writeText()` when native sharing is not
   available or fails for a non-user-cancel reason.
4. Insert one `Share Result` button only after successful finishes, next to the
   existing restart action.
5. Keep shared URLs stable by removing local-only query parameters such as
   `?test=...` before sharing.
6. Track the click with the existing Analytics seam when Firebase Analytics is
   available, without making Analytics required for sharing.

## Share Copy

First finish or normal finish:

```text
I finished SnowGlider in 42.13s. Can you beat my run?
https://snowglider.ai/
```

New personal best:

```text
New SnowGlider personal best: 42.13s. Can you beat it?
https://snowglider.ai/
```

## Non-Goals

- No social login changes.
- No per-platform buttons in the first pass.
- No Firebase writes beyond the existing score flow.
- No replay video, screenshot upload, or server-generated preview image.

## Validation

- Add focused unit coverage for share data formatting and URL cleanup.
- Add DOM smoke coverage that a share button appears only for valid finishes.
- Run `npm run lint`, `npm run typecheck`, and the targeted tests touched by the
  result overlay/share module.
