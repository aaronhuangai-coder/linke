import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildHealthResponse } from '../src/server.js';
import { LINKE_RELEASE_VERSION } from '../src/version.js';

const README_PATH = resolve(import.meta.dirname, '..', 'README.md');

describe('Release Version Consistency', () => {
  it('LINKE_RELEASE_VERSION is defined and starts with V', () => {
    assert.strictEqual(typeof LINKE_RELEASE_VERSION, 'string');
    assert.ok(LINKE_RELEASE_VERSION.startsWith('V'));
  });

  it('LINKE_RELEASE_VERSION is the V1.15 milestone', () => {
    assert.strictEqual(LINKE_RELEASE_VERSION, 'V1.15');
  });

  it('README title matches LINKE_RELEASE_VERSION', async () => {
    const readme = await readFile(README_PATH, 'utf-8');
    const firstLine = readme.split('\n')[0].trim();
    assert.strictEqual(firstLine, `# Linke ${LINKE_RELEASE_VERSION}`);
  });

  it('README badge matches LINKE_RELEASE_VERSION', async () => {
    const readme = await readFile(README_PATH, 'utf-8');
    assert.ok(readme.includes(`**当前版本：${LINKE_RELEASE_VERSION}**`), 'README badge must match current version');
  });

  it('README version table marks LINKE_RELEASE_VERSION as 当前版本', async () => {
    const readme = await readFile(README_PATH, 'utf-8');
    const lines = readme.split('\n');
    const versionRow = lines.find(line => line.includes(`| ${LINKE_RELEASE_VERSION} |`));
    assert.ok(versionRow, `README version table must contain row for version ${LINKE_RELEASE_VERSION}`);
    assert.ok(versionRow.includes('当前版本'), `Version table row for ${LINKE_RELEASE_VERSION} must be marked as "当前版本"`);
  });

  it('buildHealthResponse version matches LINKE_RELEASE_VERSION', () => {
    const res = buildHealthResponse({ dataDirReadable: true });
    assert.strictEqual(res.version, LINKE_RELEASE_VERSION);
  });
});
