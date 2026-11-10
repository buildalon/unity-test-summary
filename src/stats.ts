// Check run title and counts block.

const DIGIT_SPACE = ' ';
const PUNCTUATION_SPACE = ' ';
/** Joins the parts of a test name: a non-breaking hyphen between spaces. */
const TEST_NAME_TOKEN = ' ‑ ';

/** The counts of one test results file, as the summary shows them. */
export interface RunStats {
  files: number;
  suites: number;
  tests: number;
  passed: number;
  skipped: number;
  failed: number;
  /** Tests that failed with an exception rather than an assertion */
  errors: number;
  /** In seconds */
  duration: number;
}

/** Counts a parsed NUnit test run. Test fixtures are suites; failed tests labelled Error are errors. */
export function getRunStats(testRun: any): RunStats {
  const stats: RunStats = { files: 1, suites: 0, tests: 0, passed: 0, skipped: 0, failed: 0, errors: 0, duration: Number(testRun?.['duration']) || 0 };
  const walk = (suite: any) => {
    if (!suite) {
      return;
    }
    if (suite['type'] === 'TestFixture') {
      stats.suites++;
    }
    for (const child of [suite['test-suite'] ?? []].flat()) {
      walk(child);
    }
    for (const testCase of [suite['test-case'] ?? []].flat()) {
      stats.tests++;
      const result = `${testCase['result'] ?? ''}`;
      if (result === 'Passed') {
        stats.passed++;
      } else if (result.startsWith('Failed')) {
        if (testCase['label'] === 'Error') {
          stats.errors++;
        } else {
          stats.failed++;
        }
      } else {
        stats.skipped++;
      }
    }
  };
  for (const suite of [testRun?.['test-suite'] ?? []].flat()) {
    walk(suite);
  }
  return stats;
}

/** Formats a count padded to digits with digit spaces, and thousands split by punctuation spaces. */
export function formatNumber(value: number, digits: number = 0, label?: string): string {
  let formatted = Math.trunc(value).toLocaleString('en-US').padStart(digits, '0');
  let pos = 0;
  while (pos < formatted.length - 1 && (formatted[pos] === '0' || formatted[pos] === ',')) {
    pos++;
  }
  formatted = (formatted.substring(0, pos).split('0').join(DIGIT_SPACE) + formatted.substring(pos)).split(',').join(PUNCTUATION_SPACE);
  return label ? `${formatted} ${label}` : formatted;
}

/** Formats seconds as `1h 2m 3s`, whole seconds only. */
export function formatDuration(seconds: number, label?: string): string {
  let duration = Math.abs(Math.trunc(seconds || 0));
  const parts: string[] = [];
  for (const [unit, denominator] of [['s', 60], ['m', 60], ['h', 24]] as [string, number][]) {
    if (unit === 's' || duration) {
      parts.unshift(`${duration % denominator}${unit}`);
      duration = Math.floor(duration / denominator);
    }
  }
  if (duration) {
    parts.unshift(`${duration}d`);
  }
  const text = parts.join(' ');
  return label ? `${text} ${label}` : text;
}

/** The one-line summary for the check run title, such as `All 3 tests pass in 6s` or `1 fail, 2 pass in 6s`. */
export function getShortSummary(stats: RunStats): string {
  let summary: string;
  if (stats.tests === 0) {
    summary = 'No tests found';
  } else if (stats.failed === 0 && stats.errors === 0 && stats.skipped === 0 && stats.passed === stats.tests) {
    summary = `All ${formatNumber(stats.tests, 0, 'tests')} pass`;
  } else if (stats.failed === 0 && stats.errors === 0 && stats.skipped > 0 && stats.passed === stats.tests - stats.skipped) {
    summary = `All ${formatNumber(stats.passed, 0, 'tests')} pass, ${formatNumber(stats.skipped, 0, 'skipped')}`;
  } else {
    summary = ([[stats.errors, 'errors'], [stats.failed, 'fail'], [stats.skipped, 'skipped'], [stats.passed, 'pass']] as [number, string][])
      .filter(([count]) => count > 0)
      .map(([count, label]) => formatNumber(count, 0, label))
      .join(', ') || `${formatNumber(stats.tests, 0, 'tests')} found`;
  }
  return stats.tests === 0 ? summary : `${summary} in ${formatDuration(stats.duration)}`;
}

/**
 * The aligned counts block of the check run summary and the pull request comment:
 * ```
 * 3 tests  3 ✅  6s ⏱️
 * 1 suites  0 💤
 * 1 files    0 ❌
 * ```
 * @param detailsUrl The check run, linked from the pull request comment when tests failed
 * @param commit The commit the results are for
 */
export function getLongSummary(stats: RunStats, detailsUrl?: string, commit?: string): string {
  const sep = '  ';
  const testsDigits = Math.max(...[stats.tests, stats.suites, stats.files].map(n => formatNumber(n).length));
  const passDigits = Math.max(...[stats.passed, stats.skipped, stats.failed, stats.errors].map(n => formatNumber(n).length));
  const tests = formatNumber(stats.tests, testsDigits, 'tests ');
  const suites = formatNumber(stats.suites, testsDigits, 'suites');
  const files = formatNumber(stats.files, testsDigits, 'files  ');
  const passed = formatNumber(stats.passed, passDigits, '✅');
  const skipped = formatNumber(stats.skipped, passDigits, '💤');
  const failed = formatNumber(stats.failed, passDigits, '❌');
  const errors = stats.errors > 0 ? sep + formatNumber(stats.errors, 0, '🔥') : '';
  let summary = `${tests}${sep}${passed}${sep}${formatDuration(stats.duration, '⏱️')}\n${suites}${sep}${skipped}\n${files}${sep}${failed}${errors}\n`;
  const detailsOn = [...(stats.failed > 0 ? ['failures'] : []), ...(stats.errors > 0 ? ['errors'] : [])].join(' and ');
  if (detailsUrl && detailsOn) {
    summary += `\nFor more details on these ${detailsOn}, see [this check](${detailsUrl}).\n`;
  }
  if (commit) {
    summary += `\nResults for commit ${commit.substring(0, 8)}.\n`;
  }
  return summary;
}
