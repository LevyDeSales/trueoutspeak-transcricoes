import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { runCorrection } from '../scripts/correct.mjs';
import { exportTranscripts } from '../scripts/export.mjs';
import { syncTranscripts } from '../scripts/sync.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('exports structured JSON byte-for-byte and a readable timestamped Markdown file', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'trueoutspeak-export-'));
  const source = join(here, 'fixtures');

  const result = await exportTranscripts({ source, destination });

  assert.equal(result.count, 1);
  assert.deepEqual(result.ids, ['007']);
  assert.deepEqual(result.warnings, []);

  const sourceJson = await readFile(join(source, 'tos-007.json'));
  const exportedJson = await readFile(join(destination, 'json', 'tos-007.json'));
  assert.deepEqual(exportedJson, sourceJson);

  const markdown = await readFile(
    join(destination, 'markdown', 'tos-007.md'),
    'utf8',
  );
  assert.match(markdown, /^# TOS-007 — Transcrição$/m);
  assert.match(markdown, /Fonte da transcrição: Modelo de teste/);
  assert.match(markdown, /\*\*\[00:00:00\]\*\* Primeiro trecho\./);
  assert.match(markdown, /\*\*\[00:01:01\]\*\* Segundo trecho\./);

  const index = JSON.parse(
    await readFile(join(destination, 'indice.json'), 'utf8'),
  );
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

  const manifest = await readFile(
    join(destination, 'MANIFEST.sha256'),
    'utf8',
  );
  const manifestLines = manifest.trim().split('\n');
  assert.equal(manifestLines.length, 2);
  assert.match(
    manifestLines[0],
    /^[a-f0-9]{64}  json\/tos-007\.json$/,
  );
  assert.match(
    manifestLines[1],
    /^[a-f0-9]{64}  markdown\/tos-007\.md$/,
  );

  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(destination, 'temporal-anomalies.json'),
        'utf8',
      ),
    ),
    { schemaVersion: 1, episodes: {} },
  );
});

test('rejects overlapping source and destination without deleting the source', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'trueoutspeak-overlap-'));
  const source = join(destination, 'json');
  await mkdir(source);
  await copyFile(
    join(here, 'fixtures', 'tos-007.json'),
    join(source, 'tos-007.json'),
  );

  await assert.rejects(
    exportTranscripts({ source, destination }),
    /origem e destino.*sobrepõem/i,
  );

  const preserved = JSON.parse(
    await readFile(join(source, 'tos-007.json'), 'utf8'),
  );
  assert.equal(preserved.episodeId, '007');
});

test('rejects overlap hidden behind a symbolic-link source alias', async () => {
  const destination = await mkdtemp(
    join(tmpdir(), 'trueoutspeak-overlap-link-'),
  );
  const source = join(destination, 'json');
  const aliasRoot = await mkdtemp(join(tmpdir(), 'trueoutspeak-alias-'));
  const alias = join(aliasRoot, 'origem');
  await mkdir(source);
  await copyFile(
    join(here, 'fixtures', 'tos-007.json'),
    join(source, 'tos-007.json'),
  );
  await symlink(source, alias, 'dir');

  await assert.rejects(
    exportTranscripts({ source: alias, destination }),
    /origem e destino.*sobrepõem/i,
  );

  const preserved = JSON.parse(
    await readFile(join(source, 'tos-007.json'), 'utf8'),
  );
  assert.equal(preserved.episodeId, '007');
});

test('keeps the previous export intact when new source validation fails', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'trueoutspeak-atomic-'));
  const source = await mkdtemp(join(tmpdir(), 'trueoutspeak-invalid-'));
  await mkdir(join(destination, 'json'));
  await mkdir(join(destination, 'markdown'));
  await writeFile(join(destination, 'json', 'sentinela.txt'), 'json anterior');
  await writeFile(
    join(destination, 'markdown', 'sentinela.txt'),
    'markdown anterior',
  );
  await copyFile(
    join(here, 'fixtures', 'tos-007.json'),
    join(source, 'tos-007.json'),
  );
  await writeFile(
    join(source, 'tos-008.json'),
    JSON.stringify({ schemaVersion: 1, episodeId: '008' }),
  );

  await assert.rejects(
    exportTranscripts({ source, destination }),
    /transcrição inválida/i,
  );

  assert.equal(
    await readFile(join(destination, 'json', 'sentinela.txt'), 'utf8'),
    'json anterior',
  );
  assert.equal(
    await readFile(join(destination, 'markdown', 'sentinela.txt'), 'utf8'),
    'markdown anterior',
  );
});

test('attaches staging cleanup warnings to the primary export failure', async () => {
  const destination = await mkdtemp(
    join(tmpdir(), 'trueoutspeak-cleanup-warning-'),
  );
  const source = await mkdtemp(join(tmpdir(), 'trueoutspeak-invalid-json-'));
  await writeFile(join(source, 'tos-007.json'), '{"schemaVersion":1}\n');
  let caught;

  try {
    await exportTranscripts({
      source,
      destination,
      promotionOperations: {
        rm: async (path, options) => {
          if (path.includes('.trueoutspeak-export-stage-')) {
            throw new Error('cleanup de staging indisponível');
          }
          await rm(path, options);
        },
      },
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, 'invalid export must reject');
  assert.match(caught.message, /transcrição inválida/i);
  assert.deepEqual(caught.cleanupWarnings?.length, 1);
  assert.match(
    caught.cleanupWarnings[0],
    /cleanup.*staging de exportação.*indisponível/i,
  );
});

test('serializes export and correction without losing JSON or derived consistency', async () => {
  const destination = await mkdtemp(
    join(tmpdir(), 'trueoutspeak-export-correction-'),
  );
  await exportTranscripts({ source: join(here, 'fixtures'), destination });

  const source = await mkdtemp(
    join(tmpdir(), 'trueoutspeak-concurrent-source-'),
  );
  const exportedTranscript = JSON.parse(
    await readFile(join(here, 'fixtures', 'tos-007.json'), 'utf8'),
  );
  exportedTranscript.source = 'Export concorrente';
  await writeFile(
    join(source, 'tos-007.json'),
    `${JSON.stringify(exportedTranscript, null, 2)}\n`,
  );

  let signalExportPaused;
  const exportPaused = new Promise((resolve) => {
    signalExportPaused = resolve;
  });
  let releaseExport;
  const exportMayContinue = new Promise((resolve) => {
    releaseExport = resolve;
  });
  let paused = false;
  const exporting = exportTranscripts({
    source,
    destination,
    promotionOperations: {
      rename: async (from, to) => {
        if (
          !paused
          && from === join(destination, 'json')
          && to.includes('.trueoutspeak-export-backup-')
        ) {
          paused = true;
          signalExportPaused();
          await exportMayContinue;
        }
        await rename(from, to);
      },
    },
  });
  await exportPaused;

  let signalConfirmation;
  const confirmationReached = new Promise((resolve) => {
    signalConfirmation = resolve;
  });
  let signalSync;
  const correctionSyncReached = new Promise((resolve) => {
    signalSync = resolve;
  });
  const correcting = runCorrection({
    root: destination,
    episode: '007',
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    confirm: async () => {
      signalConfirmation();
      return true;
    },
    sync: async (options) => {
      signalSync();
      return await syncTranscripts(options);
    },
    output: () => {},
  });

  const confirmedBeforeExportReleased = await Promise.race([
    confirmationReached.then(() => true),
    delay(50, false),
  ]);
  if (confirmedBeforeExportReleased) {
    await correctionSyncReached;
  }
  releaseExport();

  const results = await Promise.allSettled([exporting, correcting]);
  assert.deepEqual(
    results.map(({ status }) => status),
    ['fulfilled', 'fulfilled'],
  );

  const finalTranscript = JSON.parse(
    await readFile(join(destination, 'json', 'tos-007.json'), 'utf8'),
  );
  assert.equal(finalTranscript.source, 'Export concorrente');
  assert.equal(finalTranscript.segments[0].text, 'Outro texto.');
  assert.deepEqual(await syncTranscripts({
    root: destination,
    check: true,
  }), {
    changed: [],
    transcripts: 1,
    warnings: [],
  });
});
