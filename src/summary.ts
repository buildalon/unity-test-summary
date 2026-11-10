/** The most characters a check run's output summary can hold. */
export const MAX_OUTPUT_LENGTH = 65535;
export const TRUNCATED_MARKER = '…truncated';

/** A test case as the summary shows it. */
export interface TestCaseSection {
  /** The test case line, with its result icon, name and duration */
  summary: string;
  /** The failure and log output of the test case */
  body: string;
  /** Whether the test did not pass, so it is shown first and open */
  failed: boolean;
}

/** Renders a test case section as markdown. */
export function renderSection(section: TestCaseSection): string {
  return testCaseSection(section.summary, section.body, section.failed);
}

/**
 * Fits a test run into a check run's output, in the first of three tiers that fits. The totals always show.
 * 1. Full: every test, with foldouts for the tests that have output.
 * 2. Compact: passing tests as plain lines without their output, and the other tests in full.
 * 3. Failures only: the tests that did not pass, and a line counting the passing tests left out. When even these
 *    overflow, each failure's output is cut evenly.
 * @param header The totals of the test run
 * @param sections The test cases of the test run, in order
 * @param maxLength The most characters the summary can hold
 * @returns The check run output summary
 */
export function buildCheckOutput(header: string, sections: TestCaseSection[], maxLength: number = MAX_OUTPUT_LENGTH): string {
  const full = header + sections.map(renderSection).join('');
  if (full.length <= maxLength) {
    return full;
  }
  const compact = header + sections.map(section => section.failed ? renderSection(section) : testCaseSection(section.summary, '', false)).join('');
  if (compact.length <= maxLength) {
    return compact;
  }
  const failures = sections.filter(section => section.failed);
  const passes = sections.length - failures.length;
  const omitted = passes > 0 ? `\n\n${passes} passing tests omitted (output limit)\n` : '';
  let summary = header + failures.map(renderSection).join('') + omitted;
  if (summary.length > maxLength) {
    summary = header + truncateFailures(failures, maxLength - header.length - omitted.length) + omitted;
  }
  if (summary.length > maxLength) {
    // too many failures to show each one: keep what fits
    summary = summary.substring(0, maxLength - TRUNCATED_MARKER.length - 2) + `\n${TRUNCATED_MARKER}\n`;
  }
  return summary;
}

/** Cuts each failure's output evenly, so all failures fit in the given length. */
function truncateFailures(failures: TestCaseSection[], maxLength: number): string {
  // each failure's foldout wrapper is fixed; the bodies share what is left, less a closing fence and the marker
  const overhead = failures.reduce((total, failure) => total + foldoutSection(failure.summary, '', true).length, 0);
  const marker = `\n${TRUNCATED_MARKER}\n`;
  const perBody = Math.floor((maxLength - overhead) / Math.max(failures.length, 1)) - marker.length - '\n```'.length;
  return failures.map(failure => {
    if (failure.body.length <= perBody) {
      return renderSection(failure);
    }
    return renderSection({ ...failure, body: truncateBody(failure.body, Math.max(perBody, 0)) + marker });
  }).join('');
}

/** Cuts markdown to a length, closing a code fence the cut leaves open. */
export function truncateBody(body: string, maxLength: number): string {
  if (body.length <= maxLength) {
    return body;
  }
  let cut = body.substring(0, maxLength);
  if ((cut.match(/```/g) ?? []).length % 2 === 1) {
    cut += '\n```';
  }
  return cut;
}

/**
 * Formats a test case for the summary: a foldout section when it has a body to show, such as a failure or log
 * output, and a plain line when it has none, so passing tests without output don't open to nothing.
 * @param summary The test case line, with its result icon, name and duration
 * @param body The failure and log output of the test case
 * @param isOpen Whether the foldout section starts open
 * @returns The test case as a markdown string
 */
export function testCaseSection(summary: string, body: string, isOpen: boolean): string {
  if (!body || body.trim() === '') {
    return `\n\n${summary}\n\n`;
  }
  return foldoutSection(summary, body, isOpen);
}

/**
 * Creates a foldout section with a summary and body.
 * @param summary The summary of the foldout section
 * @param body The body of the foldout section
 * @param isOpen Whether the foldout section is open or closed
 * @returns The foldout section as a markdown string
 */
export function foldoutSection(summary: string, body: string, isOpen: boolean): string {
  const open = isOpen ? ' open' : '';
  return `<details${open}>\n<summary>${summary}</summary>\n\n${body}\n</details>`;
}
