import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
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

async function createTwoEpisodeRoot() {
  const root = await createRoot();
  const transcript = JSON.parse(
    await readFile(join(here, 'fixtures', 'tos-007.json'), 'utf8'),
  );
  transcript.episodeId = '008';
  transcript.source = 'Estado 008 inicial';
  await writeFile(
    join(root, 'json', 'tos-008.json'),
    `${JSON.stringify(transcript, null, 2)}\n`,
  );
  return root;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test('regenerates Markdown, index, and manifest from canonical fixture JSON', async () => {
  const root = await createRoot();

  const result = await syncTranscripts({ root });

  assert.deepEqual(result, {
    changed: [
      'MANIFEST.sha256',
      'indice.json',
      'markdown/tos-007.md',
      'temporal-anomalies.json',
    ],
    transcripts: 1,
    warnings: [],
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
  assert.deepEqual(
    JSON.parse(
      await readFile(join(root, 'temporal-anomalies.json'), 'utf8'),
    ),
    { schemaVersion: 1, episodes: {} },
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
    warnings: [],
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
    readFile(join(root, 'temporal-anomalies.json')),
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
    readFile(join(root, 'temporal-anomalies.json')),
  ]);
  assert.deepEqual(derivedAfter, derivedBefore);
});

test('serializes concurrent episode syncs so an older snapshot cannot win', async () => {
  const root = await createTwoEpisodeRoot();
  await syncTranscripts({ root });

  const episode007Path = join(root, 'json', 'tos-007.json');
  const episode007 = JSON.parse(await readFile(episode007Path, 'utf8'));
  episode007.source = 'Estado 007 novo';
  await writeFile(episode007Path, `${JSON.stringify(episode007, null, 2)}\n`);

  let signalFirstPromotion;
  const firstPromotionStarted = new Promise((resolve) => {
    signalFirstPromotion = resolve;
  });
  let releaseFirstPromotion;
  const firstPromotionMayContinue = new Promise((resolve) => {
    releaseFirstPromotion = resolve;
  });
  let firstPaused = false;
  const firstSync = syncTranscripts({
    root,
    promotionOperations: {
      rename: async (source, destination) => {
        if (
          !firstPaused
          && source === join(root, 'markdown')
          && destination.includes('.trueoutspeak-sync-backup-')
        ) {
          firstPaused = true;
          signalFirstPromotion();
          await firstPromotionMayContinue;
        }
        await rename(source, destination);
      },
    },
  });
  await firstPromotionStarted;

  const episode008Path = join(root, 'json', 'tos-008.json');
  const episode008 = JSON.parse(await readFile(episode008Path, 'utf8'));
  episode008.source = 'Estado 008 novo';
  await writeFile(episode008Path, `${JSON.stringify(episode008, null, 2)}\n`);

  const globalLockPresent = await exists(
    join(root, '.trueoutspeak-derived.lock'),
  );
  const secondSync = syncTranscripts({ root });
  if (!globalLockPresent) {
    await secondSync;
  }
  releaseFirstPromotion();
  const results = await Promise.all([firstSync, secondSync]);

  assert.deepEqual(results.map(({ transcripts }) => transcripts), [2, 2]);
  assert.deepEqual(await syncTranscripts({ root, check: true }), {
    changed: [],
    transcripts: 2,
    warnings: [],
  });
  const index = JSON.parse(await readFile(join(root, 'indice.json'), 'utf8'));
  assert.equal(index.transcripts[0].source, 'Estado 007 novo');
  assert.equal(index.transcripts[1].source, 'Estado 008 novo');
  assert.match(
    await readFile(join(root, 'markdown', 'tos-008.md'), 'utf8'),
    /Fonte da transcrição: Estado 008 novo/,
  );
});

test('rejects a forged reentrant lock capability', async () => {
  const root = await createRoot();

  await assert.rejects(syncTranscripts({
    root,
    lockCapability: Object.freeze({ forged: true }),
  }), /capability|token.*lock|lock.*inválid/i);
});
