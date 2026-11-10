import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseTestResults } from '../src/parser.ts';

test('parses StandaloneLinux64-results.xml', async () => {
  const result = await parseTestResults('./tests/StandaloneLinux64-results.xml');
  assert.ok(result);
  assert.ok('id' in result);
});