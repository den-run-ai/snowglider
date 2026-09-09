// Results published by the in-page runner and read by the typed browser driver.
export {};

declare global {
  interface Window {
    _unifiedTestResults?: HTMLDivElement;
    _unifiedTestCounts?: {
      passed: number;
      failed: number;
      completed: string[];
    };
    _unifiedExpectedSuiteCount?: number;
  }
}
