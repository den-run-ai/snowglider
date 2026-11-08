// Compile-only regression: app-owned THREE metadata must not regress to `any`.
import type { createSnowman } from '../../src/snowman/model.js';
import type { Snow } from '../../src/snow.js';
import type { SnowmanUserData } from '../../src/snowman/user-data.js';

export function assertSnowmanContracts(
  model: ReturnType<typeof createSnowman>,
  splash: ReturnType<typeof Snow.createSnowSplash>,
  state: SnowmanUserData
): void {
  // @ts-expect-error Kernel accumulators are numeric at their producer too.
  model.userData.plowCharge = 'charged';
  // @ts-expect-error Jump provenance must be boolean, not a truthy string.
  state.playerJump = 'false';
  // @ts-expect-error Misspelled fields cannot fall through THREE's any index.
  state.trikSpin = 360;
  // @ts-expect-error Concrete model parts retain their THREE mesh API.
  model.userData.parts.bottom.material = 123;
  // @ts-expect-error Particle updates and initialization share a numeric lifetime.
  splash.particles[0]!.userData.lifetime = 'forever';
  // @ts-expect-error Pool state cannot silently grow misspelled fields.
  splash.particles[0]!.userData.lifeTime = 1;
}
