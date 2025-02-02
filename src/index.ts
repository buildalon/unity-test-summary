import core = require('@actions/core');
import glob = require('@actions/glob');
import {
  parseTestResults,
  parseUtp,
  parseLogs
} from './parser';
import { env } from 'process';

const main = async () => {
  try {
    const testResultsInput = core.getInput('test-results');
    core.info(`Gathering Test Results...`);
    core.summary.addHeading(`Test Results Summary`);
    core.info(`test-results:\n  > ${testResultsInput}`);
    const globber = await glob.create(testResultsInput);
    const testResultFiles = await globber.glob();
    if (testResultFiles.length === 0) {
      core.warning('No test result files found!');
      return;
    }
    core.info(`Found ${testResultFiles.length} test result files:`);
    for (const file of testResultFiles) {
      core.info(`  > ${file}`);
    }
    const testResults: any[] = [];
    for (const file of testResultFiles) {
      try {
        testResults.push(await parseTestResults(file));
      } catch (error) {
        core.error(error);
      }
    }
    for (const testResult of testResults) {
      core.debug(JSON.stringify(testResult, null, 2));
    }
    printTestSummary(testResults);
    core.summary.write();
  } catch (error) {
    core.setFailed(error);
  }
}

main();

/**
 * Prints the test summaries as markdown for the GitHub Actions Summary.
 * Similar to unity test runner, where each assembly and test suite is a foldout section, with the test results inside.
 * Each fold out section has a green checkmark or red x, depending on the test results.
 * Users can click on the foldout section to see the test results with the printed details of that specific test fixture.
 * We will also print annotations for failed tests with the error message.
 * @param testResults
 */
function printTestSummary(testResults: any[]) {
  let totalTests = 0;
  for (const testRun of testResults) {
    const testRunResult = testRun['result'].replace(/\s*\(.*?\)\s*/g, '');
    const testRunDuration = testRun['duration'];
    const testRunTotalTests = testRun['total'] as number;
    const testRunPassedTests = testRun['passed'] as number;
    const testRunFailedTests = testRun['failed'] as number;
    const testRunInconclusiveTests = testRun['inconclusive'] as number;
    const testRunSkippedTests = testRun['skipped'] as number;
    const testRunAsserts = testRun['asserts'] as number;
    const testRunStatusIcon = testRunResult === 'Passed' ? '✅' : '❌';
    let testMode = '';
    try {
      const testSuiteProperties = testRun['test-suite']['properties']['property'];
      testMode = testSuiteProperties ? testSuiteProperties['value'] : '';
    } catch (error) {
      core.error(error);
    }
    if (testResults.length > 1) {
      core.summary.addHeading(`${testRunStatusIcon} ${testMode} Test (Run ${++totalTests} of ${testResults.length}) ${testRunResult}`);
    } else {
      core.summary.addHeading(`${testRunStatusIcon} ${testMode} Test Run ${testRunResult}`);
    }
    core.summary.addRaw(`\n| ${testRunTotalTests} | Total Tests Run |\n`);
    core.summary.addRaw(`|---|---|\n`);
    core.summary.addRaw(`|🕑| ${testRunDuration} |\n`);
    core.summary.addRaw(`|✅| ${testRunPassedTests} passed |\n`);
    core.summary.addRaw(`|❌| ${testRunFailedTests} failed |\n`);
    if (testRunAsserts > 0) {
      core.summary.addRaw(`|🚩| ${testRunAsserts} asserts |\n`);
    }
    if (testRunSkippedTests > 0) {
      core.summary.addRaw(`|⏭️| ${testRunSkippedTests} skipped |\n`);
    }
    if (testRunInconclusiveTests > 0) {
      core.summary.addRaw(`|❔| ${testRunInconclusiveTests} inconclusive |\n`);
    }
    core.summary.addRaw(`\n`);
    const testSuite = testRun['test-suite'];
    if (Array.isArray(testSuite)) {
      for (const suite of testSuite) {
        core.summary.addRaw(getTestSuiteDetails(suite));
      }
    } else {
      core.summary.addRaw(getTestSuiteDetails(testSuite));
    }
  }
}

/**
 * Prints the test suite summary as foldout section.
 * @param suite
 */
function getTestSuiteDetails(testSuite: any): string {
  let details: string = '';
  const childTestSuites = testSuite['test-suite'];
  if (childTestSuites !== undefined) {

    if (Array.isArray(childTestSuites)) {
      for (const suite of childTestSuites) {
        details += getTestSuiteDetails(suite);
      }
    } else {
      details += getTestSuiteDetails(childTestSuites);
    }
  }
  const childTestCases = testSuite['test-case'];
  if (childTestCases !== undefined) {
    if (Array.isArray(childTestCases)) {
      for (const testCase of childTestCases) {
        details += getTestCaseDetails(testCase);
      }
    } else {
      details += getTestCaseDetails(childTestCases);
    }
  }
  return details;
}

/**
 * Prints the test case summary as foldout section.
 * @param testCase
 * @returns The test case details as a markdown string
 */
function getTestCaseDetails(testCase: any): string {
  const testCaseFullName = testCase['fullname'];
  const testCaseResult = testCase['result'];
  const testCaseResultIcon = testCaseResult === 'Passed' ? '✅' : '❌';
  const failure = testCase['failure'];
  let details = `\n\n`;
  if (failure) {
    details += `\`\`\`error\n`;
    const failureMessage = (failure['message'] as string).trim();
    if (failureMessage && failureMessage !== '') {
      details += `${failure['message']}\n`;
    }
    const stackTrace = (failure['stack-trace'] as string).trim();
    if (stackTrace && stackTrace !== '') {
      details += `${stackTrace}\n`;
    }
    details += `\`\`\`\n`;
  }
  const utpOutput = parseUtp(testCase['output']);
  utpOutput.map((utp) => {
    core.debug(JSON.stringify(utp, null, 2));
    // annotate failed test cases with the error message
    if (utp.type === 'TestStatus' && utp.phase === 'End' && utp.state === 5) {
      const unityProjectPath = `${env['UNITY_PROJECT_PATH'] || ''}/`;
      core.debug(`unityProjectPath: ${unityProjectPath}`);
      const workspacePath = `${env['GITHUB_WORKSPACE'] || ''}`;
      core.debug(`workspacePath: ${workspacePath}`);
      const concatProjectPath = unityProjectPath.replace(workspacePath, '');
      core.debug(`concatProjectPath: ${concatProjectPath}`);
      const utpFilePath = utp.fileName;
      core.debug(`utpFilePath: ${utpFilePath}`);
      const filePath = `${concatProjectPath}${utpFilePath}`;
      core.debug(`filePath: ${filePath}`);
      const filePathWithSeparator = filePath.replace(/(\.\/|\.\\)/, '');
      core.debug(`filePathWithSeparator: ${filePathWithSeparator}`);
      core.error(utp.message, { file: filePathWithSeparator, startLine: utp.lineNumber });
    }
  });
  const outputLines = parseLogs(testCase['output']);
  if (outputLines.length > 0) {
    details += '\n---\n';
    details += `\`\`\`log\n${outputLines.join('\n')}\n\`\`\`\n`;
  }
  return foldoutSection(`${testCaseResultIcon} ${testCaseFullName} (${testCase['duration']}s)`, details, testCaseResult !== 'Passed');
}

/**
 * Creates a foldout section with a summary and body.
 * @param summary The summary of the foldout section
 * @param body The body of the foldout section
 * @param isOpen Whether the foldout section is open or closed
 * @returns The foldout section as a markdown string
 */
function foldoutSection(summary: string, body: string, isOpen: boolean): string {
  const open = isOpen ? ' open' : '';
  return `<details${open}>\n<summary>${summary}</summary>\n\n${body}\n</details>`;
}