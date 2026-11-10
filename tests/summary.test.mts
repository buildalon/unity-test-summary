import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { TRUNCATED_MARKER, type TestCaseSection, buildCheckOutput, foldoutSection, testCaseSection, truncateBody } from '../src/summary.ts';
import { parseLogs, parseTestResults } from '../src/parser.ts';

test('testCaseSection renders a test without output as a plain line', () => {
  assert.equal(testCaseSection('✅ A.Test (0.01s)', '\n\n', false), '\n\n✅ A.Test (0.01s)\n\n');
  assert.equal(testCaseSection('✅ A.Test (0.01s)', '', false), '\n\n✅ A.Test (0.01s)\n\n');
});

test('testCaseSection renders a test with output as a foldout', () => {
  const body = '\n\n---\n```log\nhello\n```\n';
  assert.equal(testCaseSection('✅ A.Test (0.01s)', body, false), foldoutSection('✅ A.Test (0.01s)', body, false));
  assert.match(testCaseSection('❌ A.Test (0.01s)', body, true), /^<details open>/);
});

test('fixture output belongs to the test that logged it', async () => {
  const result = await parseTestResults('./tests/StandaloneLinux64-results.xml');
  const testCases: any[] = [];
  const walk = (suite: any) => {
    for (const child of [suite?.['test-suite'] ?? []].flat()) { walk(child); }
    for (const testCase of [suite?.['test-case'] ?? []].flat()) { testCases.push(testCase); }
  };
  walk(result['test-suite']);
  const logsOf = (name: string) => parseLogs(`${testCases.find(t => t['fullname'].endsWith(name))['output'] ?? ''}`);
  // only utp messages and color codes, so no foldout
  assert.deepEqual(logsOf('TestStub.RequiredTest'), []);
  // Test_01_IEnumerator runs Test_02_Async, so its own output carries Test_02_Async's log lines
  assert.ok(logsOf('Test_01_IEnumerator').some(line => line.includes('Test_02_Async starting...')));
});

const pass = (i: number, body = ''): TestCaseSection => ({ summary: `✅ Pass.${i} (0.1s)`, body, failed: false });
const fail = (i: number, body: string): TestCaseSection => ({ summary: `❌ Fail.${i} (0.1s)`, body, failed: true });
const header = '<h1>Run</h1>\n| 3 | Total Tests Run |\n';

const withLog = (body: string) => `\n\n---\n\`\`\`log\n${body}\n\`\`\`\n`;

test('buildCheckOutput tier 1 shows every test in order when it fits', () => {
  const sections = [pass(1, withLog('hello')), fail(1, '\n```error\nboom\n```\n'), pass(2)];
  const output = buildCheckOutput(header, sections, 10000);
  assert.equal(output, header + sections.map(s => testCaseSection(s.summary, s.body, s.failed)).join(''));
  assert.ok(output.indexOf('Pass.1') < output.indexOf('Fail.1'));
  assert.match(output, /<details>\n<summary>✅ Pass.1/);
  assert.ok(!output.includes('<summary>✅ Pass.2'));
});

test('buildCheckOutput tier 2 shows passing tests as plain lines without output', () => {
  const passes = Array.from({ length: 20 }, (_, i) => pass(i, withLog('x'.repeat(100))));
  const sections = [...passes, fail(1, '\n```error\nboom\n```\n')];
  const full = header + sections.map(s => testCaseSection(s.summary, s.body, s.failed)).join('');
  const output = buildCheckOutput(header, sections, full.length - 1);
  assert.ok(output.length < full.length);
  assert.ok(output.startsWith(header));
  for (let i = 0; i < 20; i++) {
    assert.ok(output.includes(`\n\n✅ Pass.${i} (0.1s)\n\n`));
  }
  assert.ok(!output.includes('xxxx'));
  assert.match(output, /<details open>\n<summary>❌ Fail.1 \(0.1s\)<\/summary>\n\n\n```error\nboom/);
  assert.ok(!output.includes('omitted'));
});

test('buildCheckOutput tier 3 shows failures only and counts the passing tests', () => {
  const passes = Array.from({ length: 50 }, (_, i) => pass(i));
  const max = 600;
  const output = buildCheckOutput(header, [...passes, fail(1, '\n```error\nboom\n```\n')], max);
  assert.ok(output.length <= max);
  assert.ok(output.startsWith(header));
  assert.ok(output.includes('boom'));
  assert.ok(!output.includes('Pass.'));
  assert.match(output, /50 passing tests omitted \(output limit\)/);
});
test('buildCheckOutput cuts each failure evenly when the failures alone overflow', () => {
  const failures = [1, 2, 3].map(i => fail(i, `\n\`\`\`error\n${String(i).repeat(2000)}\n\`\`\`\n`));
  const max = 3000;
  const output = buildCheckOutput(header, [pass(1), ...failures], max);
  assert.ok(output.length <= max);
  for (const i of [1, 2, 3]) {
    assert.ok(output.includes(`Fail.${i}`));
    assert.ok(output.includes(String(i).repeat(100)));
  }
  assert.equal(output.split(TRUNCATED_MARKER).length - 1, 3);
  // every code fence is closed
  assert.equal((output.match(/```/g) ?? []).length % 2, 0);
  assert.match(output, /1 passing tests omitted \(output limit\)/);
  // the cuts are even
  const kept = [1, 2, 3].map(i => output.match(new RegExp(`${i}{50,}`))[0].length);
  assert.ok(Math.max(...kept) - Math.min(...kept) <= 1, `uneven cuts: ${kept}`);
  assert.ok(Math.min(...kept) > 500, `cuts too short: ${kept}`);
});

test('buildCheckOutput hard cuts when there are too many failures to show each', () => {
  const failures = Array.from({ length: 200 }, (_, i) => fail(i, '\n```error\nboom\n```\n'));
  const output = buildCheckOutput(header, failures, 2000);
  assert.ok(output.length <= 2000);
  assert.ok(output.startsWith(header));
  assert.ok(output.trimEnd().endsWith(TRUNCATED_MARKER));
});

test('truncateBody closes a code fence the cut leaves open', () => {
  assert.equal(truncateBody('```log\nabcdef\n```\n', 10), '```log\nabc\n```');
  assert.equal(truncateBody('plain text here', 5), 'plain');
  assert.equal(truncateBody('short', 50), 'short');
});