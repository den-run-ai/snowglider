// Compile-only regression: window boot bridges retain the official SDK inputs.
import type { FirebaseOptions } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';
import type { Analytics } from 'firebase/analytics';

export function assertFirebaseContracts(
  auth: AuthModuleApi,
  scores: ScoresModuleApi,
  config: FirebaseOptions,
  firestore: Firestore,
  analytics: Analytics
): void {
  auth.initializeAuth?.(config);
  scores.initializeScores?.(firestore, analytics);
  scores.initializeScores?.(null, null);
  // @ts-expect-error An unknown/string config must not pass through the boot bridge.
  auth.initializeAuth?.('invalid config');
  // @ts-expect-error An arbitrary object is not a Firestore instance.
  scores.initializeScores?.({ projectId: 'not a service' }, analytics);
  // @ts-expect-error An arbitrary object is not an Analytics instance.
  scores.initializeScores?.(firestore, { enabled: true });
}
