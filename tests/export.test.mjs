import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { exportTranscripts } from '../scripts/export.mjs';

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
