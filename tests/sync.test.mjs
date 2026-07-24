import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { renderMarkdown } from '../scripts/export.mjs';
import { syncTranscripts } from '../scripts/sync.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const execFile = promisify(execFileCallback);

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-sync-'));
  await mkdir(join(root, 'json'));
  await copyFile(
    join(here, 'fixtures', 'tos-007.json'),
    join(root, 'json', 'tos-007.json'),
  );
  return root;
}

test('regenerates Markdown, index, and manifest from canonical fixture JSON', async () => {
  const root = await createRoot();

  const result = await syncTranscripts({ root });

  assert.deepEqual(result, {
    changed: [
      'MANIFEST.sha256',
      'indice.json',
      'markdown/tos-007.md',
    ],
    transcripts: 1,
  });

  const transcript = JSON.parse(
    await readFile(join(root, 'json', 'tos-007.json'), 'utf8'),
  );
  const markdown = await readFile(
    join(root, 'markdown', 'tos-007.md'),
    'utf8',
  );
  assert.equal(markdown, renderMarkdown(transcript));

  const index = JSON.parse(await readFile(join(root, 'indice.json'), 'utf8'));
  assert.deepEqual(index, {
    schemaVersion: 1,
    total: 1,
    transcripts: [
      {
        id: '007',
        code: 'TOS-007',
        source: 'Modelo de teste',
        durationSeconds: 65.5,
        json: 'json/tos-007.json',
        markdown: 'markdown/tos-007.md',
      },
    ],
  });

  const json = await readFile(join(root, 'json', 'tos-007.json'));
  const expectedManifest = [
    `${createHash('sha256').update(json).digest('hex')}  json/tos-007.json`,
    `${createHash('sha256').update(markdown).digest('hex')}  markdown/tos-007.md`,
  ].join('\n');
  assert.equal(
    await readFile(join(root, 'MANIFEST.sha256'), 'utf8'),
    `${expectedManifest}\n`,
  );
});

test('check reports derived-artifact drift without modifying files', async () => {
  const root = await createRoot();
  await syncTranscripts({ root });
  const markdownPath = join(root, 'markdown', 'tos-007.md');
  await writeFile(markdownPath, 'Markdown desatualizado\n');

  const result = await syncTranscripts({ root, check: true });

  assert.deepEqual(result, {
    changed: ['markdown/tos-007.md'],
    transcripts: 1,
  });
  assert.equal(await readFile(markdownPath, 'utf8'), 'Markdown desatualizado\n');
});

test('normal CLI synchronization succeeds after regenerating drifted artifacts', async () => {
  const root = await createRoot();

  await execFile(process.execPath, ['scripts/sync.mjs', '--root', root], {
    cwd: join(here, '..'),
  });

  assert.equal(
    await readFile(join(root, 'markdown', 'tos-007.md'), 'utf8'),
    renderMarkdown(JSON.parse(await readFile(join(root, 'json', 'tos-007.json')))),
  );
});

test('failed JSON validation leaves the existing derived tree untouched', async () => {
  const root = await createRoot();
  await syncTranscripts({ root });
  const derivedBefore = await Promise.all([
    readFile(join(root, 'markdown', 'tos-007.md')),
    readFile(join(root, 'indice.json')),
    readFile(join(root, 'MANIFEST.sha256')),
  ]);
  await writeFile(
    join(root, 'json', 'tos-008.json'),
    JSON.stringify({ schemaVersion: 1, episodeId: '008' }),
  );

  await assert.rejects(syncTranscripts({ root }), /transcrição inválida/i);

  const derivedAfter = await Promise.all([
    readFile(join(root, 'markdown', 'tos-007.md')),
    readFile(join(root, 'indice.json')),
    readFile(join(root, 'MANIFEST.sha256')),
  ]);
  assert.deepEqual(derivedAfter, derivedBefore);
});
