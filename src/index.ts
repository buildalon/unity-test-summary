import * as core from '@actions/core';
import * as github from '@actions/github';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as glob from './glob';
import {
  parseTestResults,
  parseUtp,
  parseLogs
} from './parser';
import {
  FileLinkContext,
  TestFailure,
  getBlobUrl,
  getConclusion,
  getFailureAnnotations,
  getHeadSha,
  isPermissionError,
  getStackTraceLinks,
  parseStackTraceLocation,
  parseStackTraceLocations,
  postCheckRun,
  toRepoPath,
} from './checks';
import {
  TestCaseSection,
  buildCheckOutput,
  jobSummarySection,
  renderSection,
} from './summary';
import {
  RunStats,
  getLongSummary,
  getRunStats,
  getShortSummary,
} from './stats';
import { env } from 'process';

interface TestRunSummary {
  file: string;
  testRun: any;
  header: string;
  sections: TestCaseSection[];
  failures: TestFailure[];
  stats: RunStats;
  /** The full job summary of the test run */
  markdown: string;
  /** The check run, once posted */
  check?: { name: string; url: string };
}

/** Where failure locations link to, or undefined when the repository files are unknown. */
let fileLinkContext: FileLinkContext | undefined;

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
    const testResults: { file: string; testRun: any }[] = [];
    for (const file of testResultFiles) {
      try {
        testResults.push({ file, testRun: await parseTestResults(file) });
      } catch (error) {
        core.error(error);
      }
    }
    for (const { testRun } of testResults) {
      core.debug(JSON.stringify(testRun, null, 2));
    }
    fileLinkContext = getFileLinkContext();
    const summaries = printTestSummary(testResults);
    try {
      await postCheckRuns(summaries);
    } finally {
      // a test run with a posted check run gets its counts table here and a link to the check
      for (const summary of summaries) {
        core.summary.addRaw(jobSummarySection(summary.header, summary.markdown, summary.check));
      }
      await core.summary.write();
    }
  } catch (error) {
    core.setFailed(error);
  }
}

main();

/**
 * Lists the files git tracks in the workspace, so failure locations link only to files of the repository.
 * Without a git checkout there are no links.
 */
function getFileLinkContext(): FileLinkContext | undefined {
  try {
    const { owner, repo } = github.context.repo;
    const workspacePath = env['GITHUB_WORKSPACE'] || process.cwd();
    const output = execFileSync('git', ['ls-files', '-z'], { cwd: workspacePath, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const trackedFiles = new Set(output.split('\u0000').filter(file => file.length > 0));
    core.debug(`Found ${trackedFiles.size} tracked files for failure links.`);
    return {
      blobUrl: getBlobUrl(github.context.serverUrl, owner, repo, getHeadSha(github.context)),
      trackedFiles,
      projectPath: env['UNITY_PROJECT_PATH'],
      workspacePath,
    };
  } catch (error) {
    core.debug(`No failure links: ${error.message}`);
    return undefined;
  }
}

/**
 * Posts a check run for each test run, so each run's result shows on the commit and pull request.
 * One check run per test run keeps each run's conclusion, summary and annotations apart, and within the Checks API
 * limits, where one aggregate check would mix their results and hit the summary limit sooner.
 * A token without `checks: write`, as on pull requests from forks, only warns: the job summary is already written.
 * @param summaries
 */
async function postCheckRuns(summaries: TestRunSummary[]) {
  const token = core.getInput('github-token');
  if (!token) {
    core.info('No github-token, so no check runs are posted.');
    summaries.forEach(annotateJob);
    return;
  }
  const context = github.context;
  const { owner, repo } = context.repo;
  const headSha = getHeadSha(context);
  const checkName = core.getInput('check-name') || 'Unity Test Results';
  const detailsUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  const octokit = github.getOctokit(token);
  let pullRequestComment = core.getInput('pull-request-comment') === 'true';
  for (const summary of summaries) {
    const label = path.basename(summary.file).replace(/\.xml$/i, '');
    const name = `${checkName} (${label})`;
    const annotations = getFailureAnnotations(summary.failures, env['UNITY_PROJECT_PATH'], env['GITHUB_WORKSPACE']);
    // the counts block heads the summary, and the test details follow in the tiers that fit
    const output = buildCheckOutput(`${getLongSummary(summary.stats, undefined, headSha)}\n`, summary.sections);
    let checkUrl: string | undefined;
    try {
      const { id, htmlUrl } = await postCheckRun(octokit, {
        owner,
        repo,
        headSha,
        name,
        conclusion: getConclusion(summary.testRun),
        title: getShortSummary(summary.stats),
        summary: output,
        annotations,
        detailsUrl,
      });
      checkUrl = htmlUrl;
      if (htmlUrl) {
        summary.check = { name, url: htmlUrl };
      }
      core.info(`Posted check run "${name}" (${id}) on ${headSha} with ${annotations.length} annotations.`);
    } catch (error) {
      if (isPermissionError(error)) {
        core.warning(`Could not post check runs: the github-token needs \`checks: write\` permission, which pull requests from forks never get. The job summary still has the results. (${error.message})`);
        summaries.slice(summaries.indexOf(summary)).forEach(annotateJob);
        return;
      }
      core.warning(`Could not post check run "${name}": ${error.message}`);
      annotateJob(summary);
    }
    if (pullRequestComment) {
      pullRequestComment = await postPullRequestComment(octokit, owner, repo, name, getLongSummary(summary.stats, checkUrl, headSha));
    }
  }
}

/**
 * Annotates the job with each failure of a test run whose check run could not be posted, so the failures still
 * show; a posted check run carries them already.
 */
function annotateJob(summary: TestRunSummary) {
  for (const failure of summary.failures) {
    const filePath = failure.file && failure.line > 0 ? toRepoPath(failure.file, env['UNITY_PROJECT_PATH'], env['GITHUB_WORKSPACE']) : undefined;
    core.error(failure.message || 'Test failed', filePath ? { title: failure.name, file: filePath, startLine: failure.line } : { title: failure.name });
  }
}

/**
 * Creates or updates this check's comment on the pull request: `## <check name>` and the counts
 * block, editing the latest such comment rather than adding another.
 * @returns false when the token may not comment, so later check runs skip it
 */
async function postPullRequestComment(octokit: ReturnType<typeof github.getOctokit>, owner: string, repo: string, name: string, summary: string): Promise<boolean> {
  const pullRequest = github.context.payload.pull_request;
  if (!pullRequest) {
    return true;
  }
  if (pullRequest.head?.repo?.full_name && pullRequest.head.repo.full_name !== `${owner}/${repo}`) {
    core.info('No pull request comment: the pull request comes from a fork.');
    return false;
  }
  const heading = `## ${name}\n`;
  const body = `${heading}${summary}`;
  try {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: pullRequest.number, per_page: 100 });
    const latest = comments.filter(comment => comment.user?.type === 'Bot' && comment.body?.startsWith(heading)).pop();
    if (latest) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: latest.id, body: `${body}\n:recycle: This comment has been updated with latest results.` });
    } else {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: pullRequest.number, body });
    }
    return true;
  } catch (error) {
    if (isPermissionError(error)) {
      core.warning(`Could not comment on the pull request: the github-token needs \`pull-requests: write\` permission. (${error.message})`);
      return false;
    }
    core.warning(`Could not comment on the pull request: ${error.message}`);
    return true;
  }
}

/**
 * Prints the test summaries as markdown for the GitHub Actions Summary.
 * Similar to unity test runner, where each assembly and test suite is a foldout section, with the test results inside.
 * Each fold out section has a green checkmark or red x, depending on the test results.
 * Users can click on the foldout section to see the test results with the printed details of that specific test fixture.
 * We will also print annotations for failed tests with the error message.
 * @param testResults
 * @returns Each test run's markdown and failures, for its check run
 */
function printTestSummary(testResults: { file: string; testRun: any }[]): TestRunSummary[] {
  const summaries: TestRunSummary[] = [];
  let totalTests = 0;
  for (const { file, testRun } of testResults) {
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
    const failures: TestFailure[] = [];
    let markdown = '';
    if (testResults.length > 1) {
      markdown += `<h1>${testRunStatusIcon} ${testMode} Test (Run ${++totalTests} of ${testResults.length}) ${testRunResult}</h1>\n`;
    } else {
      markdown += `<h1>${testRunStatusIcon} ${testMode} Test Run ${testRunResult}</h1>\n`;
    }
    markdown += `\n| ${testRunTotalTests} | Total Tests Run |\n`;
    markdown += `|---|---|\n`;
    markdown += `|🕑| ${testRunDuration} |\n`;
    markdown += `|✅| ${testRunPassedTests} passed |\n`;
    markdown += `|❌| ${testRunFailedTests} failed |\n`;
    if (testRunAsserts > 0) {
      markdown += `|🚩| ${testRunAsserts} asserts |\n`;
    }
    if (testRunSkippedTests > 0) {
      markdown += `|⏭️| ${testRunSkippedTests} skipped |\n`;
    }
    if (testRunInconclusiveTests > 0) {
      markdown += `|❔| ${testRunInconclusiveTests} inconclusive |\n`;
    }
    markdown += `\n`;
    const header = markdown;
    const sections: TestCaseSection[] = [];
    const testSuite = testRun['test-suite'];
    if (Array.isArray(testSuite)) {
      for (const suite of testSuite) {
        getTestSuiteDetails(suite, sections, failures);
      }
    } else {
      getTestSuiteDetails(testSuite, sections, failures);
    }
    // the job summary keeps every test in order; the check run fits its output limit
    markdown += sections.map(renderSection).join('');
    summaries.push({ file, testRun, header, markdown, sections, failures, stats: getRunStats(testRun) });
  }
  return summaries;
}

/**
 * Gathers the test cases of a test suite and its child suites.
 * @param suite
 * @param sections Collects the test case sections
 * @param failures Collects the failed test cases
 */
function getTestSuiteDetails(testSuite: any, sections: TestCaseSection[], failures: TestFailure[]) {
  const childTestSuites = testSuite['test-suite'];
  if (childTestSuites !== undefined) {

    if (Array.isArray(childTestSuites)) {
      for (const suite of childTestSuites) {
        getTestSuiteDetails(suite, sections, failures);
      }
    } else {
      getTestSuiteDetails(childTestSuites, sections, failures);
    }
  }
  const childTestCases = testSuite['test-case'];
  if (childTestCases !== undefined) {
    if (Array.isArray(childTestCases)) {
      for (const testCase of childTestCases) {
        sections.push(getTestCaseDetails(testCase, failures));
      }
    } else {
      sections.push(getTestCaseDetails(childTestCases, failures));
    }
  }
}

/**
 * Builds the test case section: a foldout with its failure and log output, or a plain line without any.
 * @param testCase
 * @param failures Collects the failed test cases
 * @returns The test case section
 */
function getTestCaseDetails(testCase: any, failures: TestFailure[]): TestCaseSection {
  const testCaseFullName = testCase['fullname'];
  const testCaseResult = testCase['result'];
  const testCaseResultIcon = testCaseResult === 'Passed' ? '✅' : '❌';
  const failure = testCase['failure'];
  const failureMessage = `${failure?.['message'] ?? ''}`.trim();
  const stackTrace = `${failure?.['stack-trace'] ?? ''}`.trim();
  let details = `\n\n`;
  if (failure) {
    details += `\`\`\`error\n`;
    if (failureMessage !== '') {
      details += `${failure['message']}\n`;
    }
    if (stackTrace !== '') {
      details += `${stackTrace}\n`;
    }
    details += `\`\`\`\n`;
  }
  const output = `${testCase['output'] ?? ''}`;
  const utpOutput = parseUtp(output);
  let utpFailure: any;
  for (const utp of utpOutput) {
    core.debug(JSON.stringify(utp, null, 2));
    if (utp.type === 'TestStatus' && utp.phase === 'End' && utp.state === 5) {
      utpFailure = utp;
    }
  }
  if (`${testCaseResult}`.startsWith('Failed') || utpFailure) {
    // prefer the location Unity reports, then the first project frame of the stack trace
    const location = utpFailure?.fileName && utpFailure?.lineNumber > 0
      ? { file: utpFailure.fileName as string, line: utpFailure.lineNumber as number }
      : parseStackTraceLocation(stackTrace || `${utpFailure?.stackTrace ?? ''}`);
    const testFailure: TestFailure = {
      name: testCaseFullName,
      message: failureMessage || `${utpFailure?.message ?? ''}`.trim(),
      stackTrace: stackTrace || `${utpFailure?.stackTrace ?? ''}`.trim(),
      file: location?.file,
      line: location?.line,
      output: parseLogs(output).join('\n'),
    };
    failures.push(testFailure);
    // link the failure's location and stack frames to the repository files
    const links = getStackTraceLinks([
      ...(location ? [location] : []),
      ...parseStackTraceLocations(testFailure.stackTrace),
    ], fileLinkContext);
    if (links) {
      details += `\n${links}`;
    }
  }
  const outputLines = parseLogs(output);
  if (outputLines.length > 0) {
    details += '\n---\n';
    details += `\`\`\`log\n${outputLines.join('\n')}\n\`\`\`\n`;
  }
  return {
    summary: `${testCaseResultIcon} ${testCaseFullName} (${testCase['duration']}s)`,
    body: details,
    failed: testCaseResult !== 'Passed',
  };
}
