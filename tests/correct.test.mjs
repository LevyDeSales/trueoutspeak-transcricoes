import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  applyCorrection,
  findSegment,
  runCorrection,
} from '../scripts/correct.mjs';

const here = dirname(fileURLToPath(import.meta.url));

async function fixture() {
  return JSON.parse(await readFile(join(here, 'fixtures', 'tos-007.json'), 'utf8'));
}

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-correct-'));
  await mkdir(join(root, 'json'));
  await copyFile(
    join(here, 'fixtures', 'tos-007.json'),
    join(root, 'json', 'tos-007.json'),
  );
  return root;
}

test('findSegment selects a unique segment by ID, timestamp, or excerpt', async () => {
  const transcript = await fixture();

  assert.equal(findSegment(transcript, { id: 'seg-0001' }).id, 'seg-0001');
  assert.equal(findSegment(transcript, { timestamp: 62 }).id, 'seg-0002');
  assert.equal(findSegment(transcript, { excerpt: 'Primeiro trecho' }).id, 'seg-0001');
});

test('findSegment rejects missing and ambiguous matches', async () => {
  const transcript = await fixture();
  transcript.segments[1].text = 'Primeiro trecho.';

  assert.throws(() => findSegment(transcript, { id: 'missing' }), /nenhum segmento/i);
  assert.throws(() => findSegment(transcript, { excerpt: 'Primeiro trecho' }), /ambígu/i);
});

test('applyCorrection rejects an expected-text mismatch without mutating input', async () => {
  const transcript = await fixture();

  assert.throws(() => applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'texto antigo',
    text: 'Texto novo aqui.',
  }), /esperado/i);
  assert.equal(transcript.segments[0].text, 'Primeiro trecho.');
});

test('applyCorrection preserves timestamps when replacement has the same word count', async () => {
  const transcript = await fixture();

  const result = applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
  });

  assert.deepEqual(result.transcript.segments[0].words, [
    { startSeconds: 0, text: 'Outro' },
    { startSeconds: 1, text: 'texto.' },
  ]);
  assert.equal(result.requiresHumanReview, false);
});

test('applyCorrection rejects a word-count change without explicit words', async () => {
  const transcript = await fixture();

  assert.throws(() => applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Primeiro novo trecho corrigido.',
  }), /words\[\]/i);
});

test('applyCorrection validates explicit words and flags count changes for human review', async () => {
  const transcript = await fixture();

  assert.throws(() => applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Primeiro novo trecho corrigido.',
    words: [{ startSeconds: 0, text: 'Primeiro' }],
  }), /corresponder/i);

  const result = applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Primeiro novo trecho corrigido.',
    words: [
      { startSeconds: 0, text: 'Primeiro' },
      { startSeconds: 0.4, text: 'novo' },
      { startSeconds: 1, text: 'trecho' },
      { startSeconds: 2, text: 'corrigido.' },
    ],
  });

  assert.equal(result.requiresHumanReview, true);
  assert.deepEqual(result.transcript.segments[0].words, [
    { startSeconds: 0, text: 'Primeiro' },
    { startSeconds: 0.4, text: 'novo' },
    { startSeconds: 1, text: 'trecho' },
    { startSeconds: 2, text: 'corrigido.' },
  ]);
});

test('applyCorrection rebuilds segment text and transcript fullText', async () => {
  const transcript = await fixture();

  const result = applyCorrection(transcript, {
    selector: { id: 'seg-0002' },
    expectedText: 'Segundo trecho.',
    text: 'Último texto.',
  });

  assert.equal(result.transcript.segments[1].text, 'Último texto.');
  assert.equal(result.transcript.fullText, 'Primeiro trecho.\nÚltimo texto.');
});

test('runCorrection does not write JSON before an explicit confirmation', async () => {
  const root = await createRoot();
  const path = join(root, 'json', 'tos-007.json');
  const before = await readFile(path, 'utf8');
  const output = [];

  const result = await runCorrection({
    root,
    episode: '007',
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    confirm: async () => false,
    write: async () => { throw new Error('não deveria escrever'); },
    output: (line) => output.push(line),
  });

  assert.deepEqual(result, { written: false, requiresHumanReview: false });
  assert.equal(await readFile(path, 'utf8'), before);
  assert.match(output.join('\n'), /Prévia/i);
});

test('runCorrection previews a replacement selected by its old excerpt', async () => {
  const root = await createRoot();
  const output = [];

  const result = await runCorrection({
    root,
    episode: '007',
    selector: { excerpt: 'Primeiro trecho' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    confirm: async () => false,
    output: (line) => output.push(line),
  });

  assert.equal(result.written, false);
  assert.match(output.join('\n'), /Depois: Outro texto\./);
});
