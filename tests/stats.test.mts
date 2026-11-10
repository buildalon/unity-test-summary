import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  formatDuration,
  formatNumber,
  getLongSummary,
  getRunStats,
  getShortSummary,
  type RunStats,
} from '../src/stats.ts';
import { parseTestResults } from '../src/parser.ts';

const DS = ' ';
const stats = (overrides: Partial<RunStats>): RunStats => ({
  files: 1, suites: 1, tests: 3, passed: 3, skipped: 0, failed: 0, errors: 0, duration: 6.17, ...overrides,
});

test('formatNumber pads with digit spaces and splits thousands', () => {
  assert.equal(formatNumber(3), '3');
  assert.equal(formatNumber(3, 3, 'tests'), `${DS}${DS}3 tests`);
  assert.equal(formatNumber(1234567), '1 234 567');
  assert.equal(formatNumber(0, 2), `${DS}0`);
});

test('formatDuration shows whole units', () => {
  assert.equal(formatDuration(6.9), '6s');
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(62), '1m 2s');
  assert.equal(formatDuration(3600), '1h 0m 0s');
  assert.equal(formatDuration(90061), '1d 1h 1m 1s');
  assert.equal(formatDuration(6, '⏱️'), '6s ⏱️');
});

test('getShortSummary builds the check run titles', () => {
  assert.equal(getShortSummary(stats({})), 'All 3 tests pass in 6s');
  assert.equal(getShortSummary(stats({ passed: 2, skipped: 1 })), 'All 2 tests pass, 1 skipped in 6s');
  assert.equal(getShortSummary(stats({ passed: 2, failed: 1 })), '1 fail, 2 pass in 6s');
  assert.equal(getShortSummary(stats({ passed: 1, failed: 1, errors: 1 })), '1 errors, 1 fail, 1 pass in 6s');
  assert.equal(getShortSummary(stats({ tests: 0, passed: 0 })), 'No tests found');
});

test('getLongSummary aligns the counts block', () => {
  assert.equal(getLongSummary(stats({})),
    '3 tests   3 ✅  6s ⏱️\n' +
    '1 suites  0 💤\n' +
    '1 files    0 ❌\n');
  assert.equal(getLongSummary(stats({ tests: 12, passed: 10, failed: 1, errors: 1 }), 'https://check', 'abcdef1234567890'),
    `12 tests   10 ✅  6s ⏱️\n` +
    `${DS}1 suites  ${DS}0 💤\n` +
    `${DS}1 files    ${DS}1 ❌  1 🔥\n` +
    '\nFor more details on these failures and errors, see [this check](https://check).\n' +
    '\nResults for commit abcdef12.\n');
});

test('getRunStats counts the fixture results', async () => {
  const result = await parseTestResults('./tests/StandaloneLinux64-results.xml');
  assert.deepEqual(getRunStats(result), { files: 1, suites: 2, tests: 3, passed: 3, skipped: 0, failed: 0, errors: 0, duration: Number(result['duration']) });
});

test('getRunStats separates errors from failures', () => {
  const run = {
    duration: '1.5',
    'test-suite': {
      type: 'TestSuite',
      'test-suite': {
        type: 'TestFixture',
        'test-case': [
          { result: 'Passed' },
          { result: 'Failed', label: 'Error' },
          { result: 'Failed' },
          { result: 'Skipped' },
          { result: 'Inconclusive' },
        ],
      },
    },
  };
  assert.deepEqual(getRunStats(run), { files: 1, suites: 1, tests: 5, passed: 1, skipped: 2, failed: 1, errors: 1, duration: 1.5 });
});
