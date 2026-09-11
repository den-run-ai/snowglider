// Results published by the in-page runner and read by the typed browser driver.
export {};

declare global {
  interface Window {
    _unifiedTestResults?: HTMLDivElement;
    _unifiedTestCounts?: {
      passed: number;
      failed: number;
      completed: string[];
      suiteResults: Record<string, { assertions: number; error: string | null }>;
      runnerErrors: string[];
    };
    _unifiedExpectedSuiteCount?: number;
    _unifiedExpectedSuites?: string[];
  }
}
