import assert from 'node:assert/strict';
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

async function createCompactRoot() {
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-correct-compact-'));
  const transcript = await fixture();
  await mkdir(join(root, 'json'));
  await writeFile(
    join(root, 'json', 'tos-007.json'),
    `${JSON.stringify(transcript)}\n`,
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

test('applyCorrection rejects explicit word timestamps in decreasing order', async () => {
  const transcript = await fixture();

  assert.throws(() => applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Primeiro novo trecho.',
    words: [
      { startSeconds: 1, text: 'Primeiro' },
      { startSeconds: 0.5, text: 'novo' },
      { startSeconds: 2, text: 'trecho.' },
    ],
  }), /não decrescente/i);
});

test('applyCorrection rejects an explicit timestamp before the segment', async () => {
  const transcript = await fixture();

  assert.throws(() => applyCorrection(transcript, {
    selector: { id: 'seg-0002' },
    expectedText: 'Segundo trecho.',
    text: 'Segundo novo trecho.',
    words: [
      { startSeconds: 60, text: 'Segundo' },
      { startSeconds: 62, text: 'novo' },
      { startSeconds: 63, text: 'trecho.' },
    ],
  }), /dentro do segmento/i);
});

test('applyCorrection rejects an explicit timestamp after the segment', async () => {
  const transcript = await fixture();

  assert.throws(() => applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Primeiro novo trecho.',
    words: [
      { startSeconds: 0, text: 'Primeiro' },
      { startSeconds: 1, text: 'novo' },
      { startSeconds: 4.5, text: 'trecho.' },
    ],
  }), /dentro do segmento/i);
});

test('applyCorrection rejects an explicit timestamp after the transcript duration', async () => {
  const transcript = await fixture();

  assert.throws(() => applyCorrection(transcript, {
    selector: { id: 'seg-0002' },
    expectedText: 'Segundo trecho.',
    text: 'Segundo novo trecho.',
    words: [
      { startSeconds: 61.1, text: 'Segundo' },
      { startSeconds: 62, text: 'novo' },
      { startSeconds: 66, text: 'trecho.' },
    ],
  }), /duração/i);
});

test('applyCorrection applies explicit same-count words and flags changed timestamps', async () => {
  const transcript = await fixture();

  const result = applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    words: [
      { startSeconds: 0.1, text: 'Outro' },
      { startSeconds: 1.5, text: 'texto.' },
    ],
  });

  assert.deepEqual(result.transcript.segments[0].words, [
    { startSeconds: 0.1, text: 'Outro' },
    { startSeconds: 1.5, text: 'texto.' },
  ]);
  assert.equal(result.requiresHumanReview, true);
});

test('applyCorrection accepts explicit same-count words with identical timestamps without review', async () => {
  const transcript = await fixture();

  const result = applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    words: [
      { startSeconds: 0, text: 'Outro' },
      { startSeconds: 1, text: 'texto.' },
    ],
  });

  assert.deepEqual(result.transcript.segments[0].words, [
    { startSeconds: 0, text: 'Outro' },
    { startSeconds: 1, text: 'texto.' },
  ]);
  assert.equal(result.requiresHumanReview, false);
});

test('applyCorrection accepts an unchanged legacy temporal profile and rejects each worsened component', async () => {
  const transcript = await fixture();
  transcript.segments[0].words[0].startSeconds = 1;
  transcript.segments[0].words[1].startSeconds = 0.5;

  const unchanged = applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    words: [
      { startSeconds: 1, text: 'Outro' },
      { startSeconds: 0.5, text: 'texto.' },
    ],
  });
  assert.equal(unchanged.requiresHumanReview, false);

  assert.throws(() => applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    words: [
      { startSeconds: 1.2, text: 'Outro' },
      { startSeconds: 0.5, text: 'texto.' },
    ],
  }), /ratchet temporal.*wordRegression.*worstDeltaSeconds/i);

  assert.throws(() => applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto agora.',
    words: [
      { startSeconds: 1, text: 'Outro' },
      { startSeconds: 0.8, text: 'texto' },
      { startSeconds: 0.7, text: 'agora.' },
    ],
  }), /ratchet temporal.*wordRegression.*count/i);
});

test('applyCorrection accepts an improved legacy temporal profile', async () => {
  const transcript = await fixture();
  transcript.segments[0].words[0].startSeconds = 1;
  transcript.segments[0].words[1].startSeconds = 0.5;

  const result = applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    words: [
      { startSeconds: 0, text: 'Outro' },
      { startSeconds: 0.5, text: 'texto.' },
    ],
  });

  assert.equal(result.requiresHumanReview, true);
});

test('applyCorrection handles legacy words containing internal spaces without inventing alignment', async () => {
  const transcript = await fixture();
  transcript.segments[0].words = [
    { startSeconds: 0, text: 'Primeiro trecho.' },
  ];

  const noOp = applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Primeiro trecho.',
  });
  assert.deepEqual(noOp.transcript.segments[0].words, transcript.segments[0].words);
  assert.equal(noOp.requiresHumanReview, false);

  assert.throws(() => applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
  }), /words\[\].*explícito/i);

  const explicit = applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    words: [{ startSeconds: 0, text: 'Outro texto.' }],
  });
  assert.equal(explicit.transcript.segments[0].text, 'Outro texto.');
  assert.equal(explicit.requiresHumanReview, false);
});

test('applyCorrection requires explicit word texts to join to correction.text exactly', async () => {
  const transcript = await fixture();

  assert.throws(() => applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    words: [
      { startSeconds: 0, text: 'Outro' },
      { startSeconds: 1, text: 'texto diferente.' },
    ],
  }), /words\[\].*texto corrigido/i);
});

test('applyCorrection applies an explicit word-count reduction and requires review', async () => {
  const transcript = await fixture();

  const result = applyCorrection(transcript, {
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Primeiro',
    words: [{ startSeconds: 0, text: 'Primeiro' }],
  });

  assert.deepEqual(result.transcript.segments[0].words, [
    { startSeconds: 0, text: 'Primeiro' },
  ]);
  assert.equal(result.requiresHumanReview, true);
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

test('runCorrection explains human review when explicit timestamps change', async () => {
  const root = await createRoot();
  const output = [];

  const result = await runCorrection({
    root,
    episode: '007',
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    words: [
      { startSeconds: 0.1, text: 'Outro' },
      { startSeconds: 1.5, text: 'texto.' },
    ],
    confirm: async () => false,
    output: (line) => output.push(line),
  });

  assert.equal(result.requiresHumanReview, true);
  assert.match(output.join('\n'), /marcação temporal/i);
  assert.match(
    output.join('\n'),
    /\| 1 \| Primeiro \| 0(?:\.0)? s \| Outro \| 0\.1 s \|/,
  );
  assert.match(
    output.join('\n'),
    /\| 2 \| trecho\. \| 1(?:\.0)? s \| texto\. \| 1\.5 s \|/,
  );
});

test('runCorrection aborts if canonical JSON changes during confirmation', async () => {
  const root = await createRoot();
  const path = join(root, 'json', 'tos-007.json');
  const concurrent = await fixture();
  concurrent.source = 'Edição concorrente';
  const concurrentContent = `${JSON.stringify(concurrent, null, 2)}\n`;
  let syncCalls = 0;

  await assert.rejects(runCorrection({
    root,
    episode: '007',
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    confirm: async () => {
      await writeFile(path, concurrentContent);
      return true;
    },
    sync: async () => { syncCalls += 1; },
    output: () => {},
  }), /conflito.*alterado/i);

  assert.equal(await readFile(path, 'utf8'), concurrentContent);
  assert.equal(syncCalls, 0);
});

test('runCorrection holds an exclusive writer lock through confirmation', async () => {
  const root = await createRoot();
  let enteredConfirmation;
  const confirmationStarted = new Promise((resolve) => {
    enteredConfirmation = resolve;
  });
  let releaseConfirmation;
  const confirmationResult = new Promise((resolve) => {
    releaseConfirmation = resolve;
  });

  const first = runCorrection({
    root,
    episode: '007',
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    confirm: async () => {
      enteredConfirmation();
      return await confirmationResult;
    },
    output: () => {},
  });
  await confirmationStarted;

  await assert.rejects(runCorrection({
    root,
    episode: '007',
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    confirm: async () => false,
    output: () => {},
  }), /correção.*andamento|lock.*exclusivo/i);

  releaseConfirmation(false);
  await first;
});

test('runCorrection atomically restores the original JSON when sync fails', async () => {
  const root = await createRoot();
  const path = join(root, 'json', 'tos-007.json');
  const before = await readFile(path, 'utf8');

  await assert.rejects(runCorrection({
    root,
    episode: '007',
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    confirm: async () => true,
    sync: async () => { throw new Error('sync indisponível'); },
  }), /sync indisponível/);

  assert.equal(await readFile(path, 'utf8'), before);
});

test('runCorrection does not overwrite a newer edit while rolling back failed sync', async () => {
  const root = await createRoot();
  const path = join(root, 'json', 'tos-007.json');
  const newer = await fixture();
  newer.source = 'Conteúdo mais recente';
  const newerContent = `${JSON.stringify(newer, null, 2)}\n`;

  await assert.rejects(runCorrection({
    root,
    episode: '007',
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    confirm: async () => true,
    sync: async () => {
      await writeFile(path, newerContent);
      throw new Error('sync indisponível');
    },
    output: () => {},
  }), /rollback.*conflito|não restaurado.*mais recente/i);

  assert.equal(await readFile(path, 'utf8'), newerContent);
});

test('runCorrection preserves compact JSON style for no-op and small corrections', async () => {
  const noOpRoot = await createCompactRoot();
  const noOpPath = join(noOpRoot, 'json', 'tos-007.json');
  const beforeNoOp = await readFile(noOpPath);

  await runCorrection({
    root: noOpRoot,
    episode: '007',
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Primeiro trecho.',
    confirm: async () => true,
    sync: async () => ({ warnings: [] }),
    output: () => {},
  });
  assert.deepEqual(await readFile(noOpPath), beforeNoOp);

  const changedRoot = await createCompactRoot();
  const changedPath = join(changedRoot, 'json', 'tos-007.json');
  const beforeChanged = await readFile(changedPath, 'utf8');
  await runCorrection({
    root: changedRoot,
    episode: '007',
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    confirm: async () => true,
    sync: async () => ({ warnings: [] }),
    output: () => {},
  });
  const afterChanged = await readFile(changedPath, 'utf8');

  assert.equal(afterChanged.split('\n').length, beforeChanged.split('\n').length);
  assert.ok(
    Math.abs(afterChanged.length - beforeChanged.length) < 100,
    'small correction must not trigger pretty-print expansion',
  );
  assert.equal(JSON.parse(afterChanged).segments[0].text, 'Outro texto.');
});

test('runCorrection reports sync cleanup warnings without rolling back JSON', async () => {
  const root = await createRoot();
  const path = join(root, 'json', 'tos-007.json');
  const output = [];

  const result = await runCorrection({
    root,
    episode: '007',
    selector: { id: 'seg-0001' },
    expectedText: 'Primeiro trecho.',
    text: 'Outro texto.',
    confirm: async () => true,
    sync: async () => ({
      warnings: ['Cleanup pendente; backup preservado em /tmp/backup.'],
    }),
    output: (line) => output.push(line),
  });

  assert.equal(result.written, true);
  assert.equal(
    JSON.parse(await readFile(path, 'utf8')).segments[0].text,
    'Outro texto.',
  );
  assert.match(output.join('\n'), /aviso.*cleanup.*backup/i);
});
