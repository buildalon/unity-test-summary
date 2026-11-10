import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  MAX_ANNOTATIONS_PER_REQUEST,
  MAX_SUMMARY_LENGTH,
  chunk,
  getConclusion,
  getFailureAnnotations,
  getHeadSha,
  abbreviate,
  isPermissionError,
  getBlobUrl,
  getStackTraceLinks,
  parseStackTraceLocation,
  parseStackTraceLocations,
  resolveRepoFile,
  postCheckRun,
  toRepoPath,
  truncateSummary,
} from '../src/checks.ts';

test('getHeadSha uses the pull request head on pull request events', () => {
  const payload = { pull_request: { head: { sha: 'head' } } };
  assert.equal(getHeadSha({ eventName: 'pull_request', sha: 'merge', payload }), 'head');
  assert.equal(getHeadSha({ eventName: 'pull_request_target', sha: 'base', payload }), 'head');
  assert.equal(getHeadSha({ eventName: 'push', sha: 'commit', payload: {} }), 'commit');
  assert.equal(getHeadSha({ eventName: 'workflow_dispatch', sha: 'commit', payload: {} }), 'commit');
});

test('getConclusion maps test run results', () => {
  assert.equal(getConclusion({ result: 'Passed', total: 3, failed: 0 }), 'success');
  assert.equal(getConclusion({ result: 'Failed(Child)', total: 3, failed: 1 }), 'failure');
  assert.equal(getConclusion({ result: 'Passed', total: 3, failed: 2 }), 'failure');
  assert.equal(getConclusion({ result: 'Skipped', total: 3, failed: 0 }), 'neutral');
  assert.equal(getConclusion({ result: 'Inconclusive', total: 3, failed: 0 }), 'neutral');
  assert.equal(getConclusion({ result: 'Passed', total: 0, failed: 0 }), 'neutral');
});

test('truncateSummary fits the check run limit', () => {
  assert.equal(truncateSummary('short'), 'short');
  const long = 'x'.repeat(MAX_SUMMARY_LENGTH + 100);
  const truncated = truncateSummary(long);
  assert.equal(truncated.length, MAX_SUMMARY_LENGTH);
  assert.match(truncated, /truncated/);
});

test('chunk splits into groups', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 50), []);
});

test('parseStackTraceLocation reads Unity stack frames', () => {
  assert.deepEqual(
    parseStackTraceLocation('at Foo.Bar () [0x00001] in /home/runner/work/r/r/Assets/Tests/Foo.cs:12 \n'),
    { file: '/home/runner/work/r/r/Assets/Tests/Foo.cs', line: 12 });
  assert.deepEqual(
    parseStackTraceLocation('Foo.Bar () (at Assets/Tests/Foo.cs:34)'),
    { file: 'Assets/Tests/Foo.cs', line: 34 });
  assert.deepEqual(
    parseStackTraceLocation('at X ()\nat Foo.Bar () (at Packages/a/Tests/B.cs:7)\nat Baz () (at Assets/C.cs:9)'),
    { file: 'Packages/a/Tests/B.cs', line: 7 });
  assert.equal(parseStackTraceLocation('no location here'), undefined);
  assert.equal(parseStackTraceLocation(''), undefined);
});

test('toRepoPath makes paths relative to the repository', () => {
  const workspace = '/home/runner/work/r/r';
  assert.equal(toRepoPath('./Packages/a/B.cs', `${workspace}/project`, workspace), 'project/Packages/a/B.cs');
  assert.equal(toRepoPath('Assets/B.cs', `${workspace}/`, workspace), 'Assets/B.cs');
  assert.equal(toRepoPath('Assets/B.cs', '', workspace), 'Assets/B.cs');
  assert.equal(toRepoPath('Assets/B.cs', 'project', workspace), 'project/Assets/B.cs');
  assert.equal(toRepoPath(`${workspace}/project/Assets/B.cs`, `${workspace}/project`, workspace), 'project/Assets/B.cs');
  assert.equal(toRepoPath('/elsewhere/B.cs', `${workspace}/project`, workspace), undefined);
  assert.equal(toRepoPath('Assets/B.cs', '/elsewhere/project', workspace), undefined);
  assert.equal(toRepoPath('.\\Assets\\B.cs', 'D:\\a\\r\\r\\project', 'D:\\a\\r\\r'), 'project/Assets/B.cs');
});

test('getFailureAnnotations annotates located failures', () => {
  const annotations = getFailureAnnotations([
    { name: 'NS.Fixture.A', message: ' Expected 1 ', stackTrace: 'at A () (at Assets/A.cs:3)', file: 'Assets/A.cs', line: 3, output: 'log line' },
    { name: 'NS.Fixture.B', message: '', stackTrace: '' },
    { name: 'C.Test', message: 'outside', stackTrace: '', file: '/elsewhere/C.cs', line: 1 },
  ], '/w/project', '/w');
  assert.deepEqual(annotations, [{
    path: 'project/Assets/A.cs',
    start_line: 3,
    end_line: 3,
    annotation_level: 'failure',
    message: 'Expected 1',
    title: 'NS.Fixture.A',
    raw_details: 'at A () (at Assets/A.cs:3)\nlog line',
  }]);
});
test('abbreviate keeps the start and end of long text', () => {
  assert.equal(abbreviate('short', 10), 'short');
  assert.equal(abbreviate('abcdefghij', 5), 'ab…ij');
  assert.equal(abbreviate('abcdefghij', 6), 'abc…ij');
  assert.equal(abbreviate('x'.repeat(70000), 64000).length, 64000);
});
function fakeClient() {
  const calls: { method: string; params: any }[] = [];
  return {
    calls,
    rest: {
      checks: {
        create: async (params: any) => { calls.push({ method: 'create', params }); return { data: { id: 42 } }; },
        update: async (params: any) => { calls.push({ method: 'update', params }); return {}; },
      },
    },
  };
}

const annotation = (i: number) => ({
  path: 'Assets/A.cs', start_line: i, end_line: i, annotation_level: 'failure' as const, message: `m${i}`,
});

test('postCheckRun creates a completed check run', async () => {
  const client = fakeClient();
  const { id } = await postCheckRun(client, {
    owner: 'o', repo: 'r', headSha: 'sha', name: 'Unity Test Results (x)', conclusion: 'success',
    title: '3 passed, 0 failed', summary: 'summary', annotations: [], detailsUrl: 'https://example.com',
  });
  assert.equal(id, 42);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].params, {
    owner: 'o', repo: 'r', name: 'Unity Test Results (x)', head_sha: 'sha', status: 'completed',
    conclusion: 'success', details_url: 'https://example.com',
    output: { title: '3 passed, 0 failed', summary: 'summary', annotations: [] },
  });
});

test('postCheckRun sends annotations in batches of 50', async () => {
  const client = fakeClient();
  const annotations = Array.from({ length: 120 }, (_, i) => annotation(i + 1));
  await postCheckRun(client, {
    owner: 'o', repo: 'r', headSha: 'sha', name: 'n', conclusion: 'failure',
    title: 't', summary: 'x'.repeat(MAX_SUMMARY_LENGTH * 2), annotations,
  });
  assert.deepEqual(client.calls.map(c => c.method), ['create', 'update', 'update']);
  assert.deepEqual(client.calls.map(c => c.params.output.annotations.length), [MAX_ANNOTATIONS_PER_REQUEST, MAX_ANNOTATIONS_PER_REQUEST, 20]);
  assert.equal(client.calls[1].params.check_run_id, 42);
  assert.equal(client.calls[2].params.output.annotations[0].start_line, 101);
  for (const call of client.calls) {
    assert.ok(call.params.output.summary.length <= MAX_SUMMARY_LENGTH);
  }
});

test('isPermissionError matches forbidden responses', () => {
  assert.equal(isPermissionError({ status: 403 }), true);
  assert.equal(isPermissionError({ status: 404 }), true);
  assert.equal(isPermissionError({ status: 500 }), false);
  assert.equal(isPermissionError(new Error('x')), false);
});

test('parseStackTraceLocations reads every frame', () => {
  assert.deepEqual(
    parseStackTraceLocations('at A () (at Assets/A.cs:1)\nat B ()\nat C () in /w/r/Assets/C.cs:3'),
    [{ file: 'Assets/A.cs', line: 1 }, { file: '/w/r/Assets/C.cs', line: 3 }]);
  assert.deepEqual(parseStackTraceLocations(''), []);
});

test('resolveRepoFile maps reported paths to tracked files', () => {
  const tracked = new Set(['UnityProject/Assets/Tests/Foo.cs', 'Assets/Bar.cs', 'src/index.ts']);
  // project relative, with the project in a subfolder of the repository
  assert.equal(resolveRepoFile('./Assets/Tests/Foo.cs', tracked, '/w/UnityProject', '/w'), 'UnityProject/Assets/Tests/Foo.cs');
  // absolute, inside the workspace
  assert.equal(resolveRepoFile('/w/UnityProject/Assets/Tests/Foo.cs', tracked, '/w/UnityProject', '/w'), 'UnityProject/Assets/Tests/Foo.cs');
  // a working directory offset the project path does not explain: the longest tracked suffix
  assert.equal(resolveRepoFile('/other/checkout/UnityProject/Assets/Tests/Foo.cs', tracked, '', '/w'), 'UnityProject/Assets/Tests/Foo.cs');
  assert.equal(resolveRepoFile('C:\\agent\\_work\\r\\Assets\\Bar.cs', tracked, '', 'D:\\a\\r'), 'Assets/Bar.cs');
  // not a file of the repository, such as a package cache or a nested checkout
  assert.equal(resolveRepoFile('./Library/PackageCache/com.unity.x/Tests/Baz.cs', tracked, '/w/UnityProject', '/w'), undefined);
  assert.equal(resolveRepoFile('Assets/Bar.cs.bak', tracked, '', '/w'), undefined);
  assert.equal(resolveRepoFile('./Assets/Tests/Foo.cs', new Set(), '/w/UnityProject', '/w'), undefined);
});

test('getStackTraceLinks links repository files at the head commit', () => {
  const context = {
    blobUrl: getBlobUrl('https://github.com', 'owner', 'repo', 'abc123'),
    trackedFiles: new Set(['UnityProject/Assets/Tests/My Foo.cs', 'UnityProject/Assets/Bar.cs']),
    projectPath: '/w/UnityProject',
    workspacePath: '/w',
  };
  const links = getStackTraceLinks([
    { file: './Assets/Tests/My Foo.cs', line: 12 },
    { file: '/w/UnityProject/Assets/Tests/My Foo.cs', line: 12 },
    { file: './Library/PackageCache/x/Baz.cs', line: 3 },
    { file: 'Assets/Bar.cs', line: 7 },
  ], context);
  assert.equal(links,
    '- [UnityProject/Assets/Tests/My Foo.cs:12](https://github.com/owner/repo/blob/abc123/UnityProject/Assets/Tests/My%20Foo.cs#L12)\n' +
    '- [UnityProject/Assets/Bar.cs:7](https://github.com/owner/repo/blob/abc123/UnityProject/Assets/Bar.cs#L7)\n');
  assert.equal(getStackTraceLinks([{ file: './Library/PackageCache/x/Baz.cs', line: 3 }], context), '');
  assert.equal(getStackTraceLinks([{ file: 'Assets/Bar.cs', line: 7 }], undefined), '');
});