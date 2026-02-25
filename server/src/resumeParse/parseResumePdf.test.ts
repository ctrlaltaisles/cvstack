import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseResumeFromLines, type ExtractedLine } from './parseResumePdf';

function loadJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

const baseDir = __dirname;
const fixturesDir = path.join(baseDir, '__fixtures__');
const snapshotsDir = path.join(baseDir, '__snapshots__');

const fixtures = ['simple', 'two-column', 'messy'];

for (const name of fixtures) {
  test(`parseResumeFromLines fixture: ${name}`, () => {
    const lines = loadJson<ExtractedLine[]>(path.join(fixturesDir, `${name}.json`));
    const result = parseResumeFromLines(lines);
    const snapshotPath = path.join(snapshotsDir, `${name}.snapshot.json`);
    const expected = loadJson(snapshotPath);
    assert.deepEqual(result, expected);
  });
}
