import { TEST_PORTS, startTestApp } from './start-test-app.mjs';

// Issue #9 keeps this compatibility boundary until the remaining test callers
// move to the common name.
export const MANAGE_TEST_PORTS = TEST_PORTS;
export const startManageTestApp = startTestApp;
