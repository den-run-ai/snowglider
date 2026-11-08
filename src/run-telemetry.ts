import type { Difficulty } from './difficulty.js';
import { getRunStamp } from './run-context.js';

/** Low-cardinality run context, without player IDs, seeds or replay nonces. */
export function runTelemetryContext(
  difficulty: Difficulty,
  timingCompromised = false,
): Record<string, string | number> {
  const stamp = getRunStamp();
  return {
    difficulty,
    physics_version: stamp.physicsVersion,
    practice: stamp.practice ? 'true' : 'false',
    timing_compromised: timingCompromised ? 'true' : 'false',
  };
}
