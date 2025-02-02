import * as fs from "fs";
import { XMLParser } from "fast-xml-parser";

/**
 * Try to parse the test results.
 * @param file
 * @returns The parsed test results
 */
export async function parseTestResults(file: string): Promise<any> {
  await fs.promises.access(file, fs.constants.R_OK);
  if (!file.endsWith('.xml')) {
    throw new Error(`${file} is not an xml file.`);
  }
  const contents = await fs.promises.readFile(file, 'utf8');
  const parser = new XMLParser({
    attributeNamePrefix: ``,
    ignoreAttributes: false,
  });
  const obj = parser.parse(contents);
  const testJson = JSON.stringify(obj['test-run'], null, 2);
  return JSON.parse(testJson);
}

/**
 * parse the utp output.
 * @param output
 * @returns The parsed utp output as an array of objects
 */
export function parseUtp(output: string): any[] {
  let objs = [];
  const regex = /##utp:({.*})/g;
  let match: string[];
  while ((match = regex.exec(output)) !== null) {
    objs.push(JSON.parse(match[1]));
  }
  return objs;
}

export function parseLogs(output: string): any[] {
  const logs = [];
  const lines = output.split('\n');
  for (let line of lines) {
    if (line.match(/##utp:/)) {
      continue;
    }
    line = line.replace(/\\u001b\[[0-9]*m/g, '').trim();
    if (line === '' || line.startsWith('Saving results to:')) {
      continue;
    }
    logs.push(line);
  }
  return logs;
}
