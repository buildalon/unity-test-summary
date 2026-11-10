/** The most annotations the Checks API takes in one request. */
export const MAX_ANNOTATIONS_PER_REQUEST = 50;
/** The most characters a check run's output summary can hold. */
export const MAX_SUMMARY_LENGTH = 65535;
const MAX_TITLE_LENGTH = 255;
const MAX_DETAILS_LENGTH = 65535;
const TRUNCATED_NOTICE = '\n\n…the summary is truncated; the job summary has the full results.\n';

export type CheckConclusion = 'success' | 'failure' | 'neutral';

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title?: string;
  raw_details?: string;
}

export interface CheckRunOptions {
  owner: string;
  repo: string;
  headSha: string;
  name: string;
  conclusion: CheckConclusion;
  title: string;
  summary: string;
  annotations: CheckAnnotation[];
  detailsUrl?: string;
}

/** The part of an octokit client this module uses. */
export interface ChecksClient {
  rest: {
    checks: {
      create(params: any): Promise<{ data: { id: number; html_url?: string } }>;
      update(params: any): Promise<unknown>;
    };
  };
}

/** A failed test case, with the file and line it failed on when the results have them. */
export interface TestFailure {
  name: string;
  message: string;
  stackTrace: string;
  /** The log output of the test, without utp messages */
  output?: string;
  file?: string;
  line?: number;
}

/**
 * Picks the commit the check run belongs on. Pull request events run on a merge commit that the pull request
 * never shows, so their check runs go on the head commit instead.
 */
export function getHeadSha(context: { eventName: string; sha: string; payload: any }): string {
  const pullRequest = context.payload?.pull_request;
  if ((context.eventName === 'pull_request' || context.eventName === 'pull_request_target') && pullRequest?.head?.sha) {
    return pullRequest.head.sha;
  }
  return context.sha;
}

/** Maps a test run's result to a check run conclusion. */
export function getConclusion(testRun: any): CheckConclusion {
  const result = `${testRun?.['result'] ?? ''}`;
  const failed = Number(testRun?.['failed'] ?? 0);
  const total = Number(testRun?.['total'] ?? 0);
  if (failed > 0 || result.startsWith('Failed')) {
    return 'failure';
  }
  if (total === 0 || !result.startsWith('Passed')) {
    return 'neutral';
  }
  return 'success';
}

/** Cuts the summary to fit a check run, and says so when it does. */
export function truncateSummary(summary: string, maxLength: number = MAX_SUMMARY_LENGTH): string {
  if (summary.length <= maxLength) {
    return summary;
  }
  return summary.substring(0, maxLength - TRUNCATED_NOTICE.length) + TRUNCATED_NOTICE;
}

/** Splits items into groups of at most size. */
export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Finds the first `<file>.cs:<line>` location in a Unity stack trace, such as `(at Assets/Tests/Foo.cs:12)`
 * or `in /home/runner/work/repo/repo/Assets/Tests/Foo.cs:12`.
 */
export function parseStackTraceLocation(stackTrace: string): { file: string; line: number } | undefined {
  return parseStackTraceLocations(stackTrace)[0];
}

/** Finds every `<file>.cs:<line>` location in a Unity stack trace, one per frame, in order. */
export function parseStackTraceLocations(stackTrace: string): { file: string; line: number }[] {
  const locations: { file: string; line: number }[] = [];
  if (!stackTrace) {
    return locations;
  }
  for (const rawLine of stackTrace.split('\n')) {
    const text = rawLine.trim();
    const marker = text.lastIndexOf('.cs:');
    if (marker < 0) {
      continue;
    }
    let start = marker;
    while (start > 0 && !' \t('.includes(text[start - 1])) {
      start--;
    }
    let end = marker + 4;
    while (end < text.length && text[end] >= '0' && text[end] <= '9') {
      end++;
    }
    const line = Number(text.substring(marker + 4, end));
    const file = text.substring(start, marker + 3);
    if (line > 0 && file.length > 3) {
      locations.push({ file, line });
    }
  }
  return locations;
}

/**
 * Finds the repository file a reported path points to: the path made relative to the
 * repository when it is tracked, or else the longest tracked file the path ends with, which covers a working
 * directory or project path offset.
 * @param file The path from the test results, relative to the Unity project or absolute
 * @param trackedFiles The files git tracks, relative to the repository root
 * @returns The tracked file, or undefined when the path is not a file of the repository
 */
export function resolveRepoFile(file: string, trackedFiles: ReadonlySet<string>, projectPath: string = '', workspacePath: string = ''): string | undefined {
  if (!file || trackedFiles.size === 0) {
    return undefined;
  }
  const repoPath = toRepoPath(file, projectPath, workspacePath);
  if (repoPath && trackedFiles.has(repoPath)) {
    return repoPath;
  }
  const normalized = file.split('\\').join('/');
  let best: string | undefined;
  for (const tracked of trackedFiles) {
    if ((normalized === tracked || normalized.endsWith(`/${tracked}`)) && tracked.length > (best?.length ?? 0)) {
      best = tracked;
    }
  }
  return best;
}

/** Where failure locations link to: the repository files at the commit the check run is on. */
export interface FileLinkContext {
  /** Such as `https://github.com/owner/repo/blob/<sha>` */
  blobUrl: string;
  trackedFiles: ReadonlySet<string>;
  projectPath?: string;
  workspacePath?: string;
}

/** Builds the blob URL that file links start with. */
export function getBlobUrl(serverUrl: string, owner: string, repo: string, sha: string): string {
  return `${serverUrl}/${owner}/${repo}/blob/${sha}`;
}

/**
 * Links each distinct stack trace location that is a file of the repository, as a markdown list.
 * @returns The markdown list, or an empty string when no location is in the repository
 */
export function getStackTraceLinks(locations: { file: string; line: number }[], context: FileLinkContext | undefined): string {
  if (!context) {
    return '';
  }
  const links: string[] = [];
  const seen = new Set<string>();
  for (const location of locations) {
    const file = resolveRepoFile(location.file, context.trackedFiles, context.projectPath, context.workspacePath);
    const key = `${file}:${location.line}`;
    if (!file || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const encoded = file.split('/').map(encodeURIComponent).join('/');
    links.push(`- [${file}:${location.line}](${context.blobUrl}/${encoded}#L${location.line})`);
  }
  return links.length > 0 ? `${links.join('\n')}\n` : '';
}

/**
 * Makes a file path from the test results relative to the repository, as annotations need.
 * Unity reports paths relative to the project, or absolute.
 * @returns The repository relative path, or undefined when the file is outside the workspace
 */
export function toRepoPath(file: string, projectPath: string = '', workspacePath: string = ''): string | undefined {
  if (!file) {
    return undefined;
  }
  const workspace = normalizePath(workspacePath);
  // an absolute path, or one under an absolute project path, must be inside the workspace
  const fromWorkspace = (value: string): string | undefined => {
    if (!isAbsolutePath(value)) {
      return value;
    }
    if (workspace && value.toLowerCase().startsWith(`${workspace.toLowerCase()}/`)) {
      return value.substring(workspace.length + 1);
    }
    return undefined;
  };
  const filePath = fromWorkspace(normalizePath(file));
  if (filePath === undefined || isAbsolutePath(normalizePath(file))) {
    return filePath;
  }
  const project = normalizePath(projectPath) === workspace ? '' : fromWorkspace(normalizePath(projectPath));
  if (project === undefined) {
    return undefined;
  }
  let relative = filePath;
  while (relative.startsWith('./')) {
    relative = relative.substring(2);
  }
  return project ? `${project}/${relative}` : relative;
}

function normalizePath(value: string): string {
  let normalized = (value ?? '').split('\\').join('/');
  while (normalized.endsWith('/')) {
    normalized = normalized.substring(0, normalized.length - 1);
  }
  return normalized;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value);
}

/**
 * Builds the failure annotations of a test run: one per failed test with a file in the workspace, on that file and
 * line, with the failure message, and the stack trace and log output as raw details. Long text keeps its start
 * and end.
 */
export function getFailureAnnotations(failures: TestFailure[], projectPath: string = '', workspacePath: string = ''): CheckAnnotation[] {
  const annotations: CheckAnnotation[] = [];
  for (const failure of failures) {
    const path = failure.file ? toRepoPath(failure.file, projectPath, workspacePath) : undefined;
    if (!path || !(failure.line > 0)) {
      continue;
    }
    const annotation: CheckAnnotation = {
      path,
      start_line: failure.line,
      end_line: failure.line,
      annotation_level: 'failure',
      message: abbreviate(failure.message?.trim() || 'Test failed', MAX_DETAILS_LENGTH),
      title: abbreviate(failure.name, MAX_TITLE_LENGTH),
    };
    const details = [failure.stackTrace?.trim(), failure.output?.trim()].filter(Boolean);
    if (details.length > 0) {
      annotation.raw_details = abbreviate(details.join('\n'), MAX_DETAILS_LENGTH);
    }
    annotations.push(annotation);
  }
  return annotations;
}

/** Shortens text to length by cutting out its middle for an ellipsis, keeping its start and end. */
export function abbreviate(text: string, length: number): string {
  if (text === undefined || text === null || text.length <= length) {
    return text;
  }
  const pre = Math.floor(length / 2);
  const suf = Math.floor((length - 1) / 2);
  return text.substring(0, pre) + '…' + (suf ? text.substring(text.length - suf) : '');
}

/**
 * Posts a completed check run. The first 50 annotations go with the create request and the rest follow in
 * update requests of 50, since the Checks API takes no more per request.
 * @returns The check run id and page
 */
export async function postCheckRun(client: ChecksClient, options: CheckRunOptions): Promise<{ id: number; htmlUrl?: string }> {
  const batches = chunk(options.annotations, MAX_ANNOTATIONS_PER_REQUEST);
  const output = {
    title: truncate(options.title, MAX_TITLE_LENGTH),
    summary: truncateSummary(options.summary),
  };
  const { data } = await client.rest.checks.create({
    owner: options.owner,
    repo: options.repo,
    name: options.name,
    head_sha: options.headSha,
    status: 'completed',
    conclusion: options.conclusion,
    ...(options.detailsUrl ? { details_url: options.detailsUrl } : {}),
    output: { ...output, annotations: batches[0] ?? [] },
  });
  for (const batch of batches.slice(1)) {
    await client.rest.checks.update({
      owner: options.owner,
      repo: options.repo,
      check_run_id: data.id,
      output: { ...output, annotations: batch },
    });
  }
  return { id: data.id, htmlUrl: data.html_url };
}

/** Whether an API error means the token may not write check runs, as with pull requests from forks. */
export function isPermissionError(error: any): boolean {
  return error?.status === 403 || error?.status === 404;
}

function truncate(value: string, maxLength: number): string {
  if (!value || value.length <= maxLength) {
    return value;
  }
  return value.substring(0, maxLength - 1) + '…';
}
