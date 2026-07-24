import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  assertTranscript,
  exportTranscripts,
  renderMarkdown,
} from '../scripts/export.mjs';
import { syncTranscripts } from '../scripts/sync.mjs';
import { verifyRepository } from '../scripts/verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const execFile = promisify(execFileCallback);

async function git(root, ...args) {
  const { stdout } = await execFile('git', ['-C', root, ...args]);
  return stdout.trim();
}

async function createGitRepository() {
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-git-verify-'));
  await exportTranscripts({
    source: join(here, 'fixtures'),
    destination: root,
  });
  await writeFile(join(root, '.gitignore'), '.superpowers/\n');
  await git(root, 'init');
  await git(root, 'add', '--all');
  return root;
}

async function validTranscript() {
  const transcript = JSON.parse(
    await readFile(join(here, 'fixtures', 'tos-007.json'), 'utf8'),
  );
  transcript.fullText = transcript.segments
    .map(({ text }) => text)
    .join('\n');
  return transcript;
}

async function createExportRoot() {
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-verify-export-'));
  await exportTranscripts({
    source: join(here, 'fixtures'),
    destination: root,
  });
  return root;
}

async function mutateCanonicalTranscript(root, mutate) {
  const path = join(root, 'json', 'tos-007.json');
  const transcript = JSON.parse(await readFile(path, 'utf8'));
  mutate(transcript);
  await writeFile(path, `${JSON.stringify(transcript, null, 2)}\n`);
}

test('accepts a complete transcript-only export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-verify-'));
  await exportTranscripts({
    source: join(here, 'fixtures'),
    destination: root,
  });

  const report = await verifyRepository({
    root,
    expectedIds: ['007'],
  });

  assert.deepEqual(report, {
    transcripts: 1,
    markdownFiles: 1,
    jsonFiles: 1,
    audioFiles: 0,
  });
});

test('accepts legacy temporal anomalies captured by the versioned profile', async () => {
  const source = await mkdtemp(join(tmpdir(), 'trueoutspeak-legacy-source-'));
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-legacy-verify-'));
  const transcript = await validTranscript();
  transcript.segments[0].words[0].startSeconds = 1;
  transcript.segments[0].words[1].startSeconds = 0.5;
  transcript.segments[1].words[0].startSeconds = 60;
  transcript.segments[1].words[1].startSeconds = 66;
  await writeFile(
    join(source, 'tos-007.json'),
    `${JSON.stringify(transcript, null, 2)}\n`,
  );
  await exportTranscripts({ source, destination: root });

  const profile = JSON.parse(
    await readFile(join(root, 'temporal-anomalies.json'), 'utf8'),
  );
  assert.deepEqual(profile, {
    schemaVersion: 1,
    episodes: {
      '007': {
        'seg-0001': {
          wordRegression: {
            count: 1,
            worstDeltaSeconds: 0.5,
          },
        },
        'seg-0002': {
          beforeSegment: {
            count: 1,
            worstDeltaSeconds: 1.1,
          },
          afterSegment: {
            count: 1,
            worstDeltaSeconds: 0.5,
          },
          outsideDuration: {
            count: 1,
            worstDeltaSeconds: 0.5,
          },
        },
      },
    },
  });

  const report = await verifyRepository({ root, expectedIds: ['007'] });
  assert.equal(report.transcripts, 1);
});

test('ignores untracked scratch files ignored by Git', async () => {
  const root = await createGitRepository();
  await mkdir(join(root, '.superpowers', 'sdd'), { recursive: true });
  await writeFile(join(root, '.superpowers', 'sdd', 'scratch.md'), 'local');

  const report = await verifyRepository({ root, expectedIds: ['007'] });

  assert.equal(report.transcripts, 1);
});

test('accepts every approved contribution support path', async () => {
  const root = await createGitRepository();
  const approvedPaths = [
    '.github/ISSUE_TEMPLATE/config.yml',
    '.github/ISSUE_TEMPLATE/correcao-transcricao.yml',
    '.github/pull_request_template.md',
    'CONTRIBUTING.md',
    'docs/superpowers/plans/2026-07-24-contribution-workflow.md',
    'docs/superpowers/specs/2026-07-24-contribution-workflow-design.md',
    'scripts/correct.mjs',
    'tests/correct.test.mjs',
  ];
  for (const relativePath of approvedPaths) {
    await mkdir(dirname(join(root, relativePath)), { recursive: true });
    await writeFile(join(root, relativePath), 'conteúdo versionado');
  }

  const report = await verifyRepository({ root, expectedIds: ['007'] });

  assert.equal(report.transcripts, 1);
});

test('rejects a tracked file even when its path is Git-ignored', async () => {
  const root = await createGitRepository();
  const forbiddenPath = join(root, '.superpowers', 'sdd', 'proibido.txt');
  await mkdir(join(root, '.superpowers', 'sdd'), { recursive: true });
  await writeFile(forbiddenPath, 'não permitido');
  await git(root, 'add', '--force', '.superpowers/sdd/proibido.txt');

  await assert.rejects(
    verifyRepository({ root, expectedIds: ['007'] }),
    /arquivo não permitido.*proibido\.txt/i,
  );
});

test('rejects duplicate segment IDs', async () => {
  const transcript = await validTranscript();
  transcript.segments[1].id = transcript.segments[0].id;

  assert.throws(
    () => assertTranscript(transcript, 'tos-007.json'),
    /IDs de segmento.*únicos/i,
  );
});

test('rejects out-of-order segment IDs', async () => {
  const transcript = await validTranscript();
  transcript.segments[0].id = 'seg-0002';
  transcript.segments[1].id = 'seg-0001';

  assert.throws(
    () => assertTranscript(transcript, 'tos-007.json'),
    /IDs de segmento.*ordem crescente/i,
  );
});

test('rejects decreasing word timestamps', async () => {
  const root = await createExportRoot();
  await mutateCanonicalTranscript(root, (transcript) => {
    transcript.segments[0].words[0].startSeconds = 1;
    transcript.segments[0].words[1].startSeconds = 0.5;
  });

  await assert.rejects(
    verifyRepository({ root, expectedIds: ['007'] }),
    /perfil de anomalias temporais.*diverge/i,
  );
});

test('rejects word timestamps outside their segment', async () => {
  const root = await createExportRoot();
  await mutateCanonicalTranscript(root, (transcript) => {
    transcript.segments[1].words[0].startSeconds = 60;
  });

  await assert.rejects(
    verifyRepository({ root, expectedIds: ['007'] }),
    /perfil de anomalias temporais.*diverge/i,
  );
});

test('rejects word timestamps outside the transcript duration', async () => {
  const root = await createExportRoot();
  await mutateCanonicalTranscript(root, (transcript) => {
    transcript.segments[1].words[1].startSeconds = 66;
  });

  await assert.rejects(
    verifyRepository({ root, expectedIds: ['007'] }),
    /perfil de anomalias temporais.*diverge/i,
  );
});

test('rejects segment timestamps outside the transcript duration', async () => {
  const transcript = await validTranscript();
  transcript.segments[1].endSeconds = 66;

  assert.throws(
    () => assertTranscript(transcript, 'tos-007.json'),
    /segmento.*duração/i,
  );
});

test('rejects segment text that diverges from its words', async () => {
  const transcript = await validTranscript();
  transcript.segments[0].words[0].text = 'Outro';

  assert.throws(
    () => assertTranscript(transcript, 'tos-007.json'),
    /texto do segmento.*palavras/i,
  );
});

test('rejects full text that diverges from its segments', async () => {
  const transcript = await validTranscript();
  transcript.fullText = transcript.segments.map(({ text }) => text).join(' ');

  assert.throws(
    () => assertTranscript(transcript, 'tos-007.json'),
    /texto completo.*segmentos/i,
  );
});

test('temporal ratchet rejects increased anomaly counts and deltas', async () => {
  const { assertTemporalRatchet } = await import('../scripts/verify.mjs');
  assert.equal(
    typeof assertTemporalRatchet,
    'function',
    'verify must expose the temporal ratchet',
  );
  const baseline = {
    schemaVersion: 1,
    episodes: {
      '007': {
        'seg-0001': {
          wordRegression: {
            count: 1,
            worstDeltaSeconds: 0.5,
          },
        },
      },
    },
  };

  const increasedCount = structuredClone(baseline);
  increasedCount.episodes['007']['seg-0001'].wordRegression.count = 2;
  assert.throws(
    () => assertTemporalRatchet(increasedCount, baseline),
    /ratchet.*wordRegression.*count/i,
  );

  const increasedDelta = structuredClone(baseline);
  increasedDelta.episodes['007']['seg-0001']
    .wordRegression.worstDeltaSeconds = 0.6;
  assert.throws(
    () => assertTemporalRatchet(increasedDelta, baseline),
    /ratchet.*wordRegression.*worstDeltaSeconds/i,
  );

  const newAnomaly = structuredClone(baseline);
  newAnomaly.episodes['007']['seg-0002'] = {
    beforeSegment: {
      count: 1,
      worstDeltaSeconds: 0.1,
    },
  };
  assert.throws(
    () => assertTemporalRatchet(newAnomaly, baseline),
    /ratchet.*beforeSegment.*count/i,
  );
});

test('temporal ratchet accepts a reduced profile with its snapshot updated', async () => {
  const { assertTemporalRatchet } = await import('../scripts/verify.mjs');
  assert.equal(
    typeof assertTemporalRatchet,
    'function',
    'verify must expose the temporal ratchet',
  );
  const baseline = {
    schemaVersion: 1,
    episodes: {
      '007': {
        'seg-0001': {
          wordRegression: {
            count: 2,
            worstDeltaSeconds: 0.5,
          },
        },
      },
    },
  };
  const reduced = {
    schemaVersion: 1,
    episodes: {
      '007': {
        'seg-0001': {
          wordRegression: {
            count: 1,
            worstDeltaSeconds: 0.4,
          },
        },
      },
    },
  };

  assert.doesNotThrow(() => assertTemporalRatchet(reduced, baseline));
});

test('temporal ratchet compares the branch profile with its Git merge-base', async () => {
  const root = await createExportRoot();
  await git(root, 'init');
  await git(root, 'add', '--all');
  await git(
    root,
    '-c',
    'user.name=TrueOutspeak Tests',
    '-c',
    'user.email=tests@example.invalid',
    'commit',
    '-m',
    'baseline',
  );
  await mutateCanonicalTranscript(root, (transcript) => {
    transcript.segments[0].words[0].startSeconds = 1;
    transcript.segments[0].words[1].startSeconds = 0.5;
  });
  await syncTranscripts({ root });

  await assert.rejects(
    verifyRepository({
      root,
      expectedIds: ['007'],
      baselineRef: 'HEAD',
      baselineMode: 'merge-base',
    }),
    /ratchet temporal.*wordRegression.*count/i,
  );
});

test('direct push baseline rejects a force-pushed reintroduction that merge-base allows', async () => {
  const source = await mkdtemp(join(tmpdir(), 'trueoutspeak-force-source-'));
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-force-verify-'));
  const transcript = await validTranscript();
  transcript.segments[0].words[0].startSeconds = 1;
  transcript.segments[0].words[1].startSeconds = 0.5;
  await writeFile(
    join(source, 'tos-007.json'),
    `${JSON.stringify(transcript, null, 2)}\n`,
  );
  await exportTranscripts({ source, destination: root });
  await git(root, 'init');
  await git(root, 'add', '--all');
  await git(
    root,
    '-c',
    'user.name=TrueOutspeak Tests',
    '-c',
    'user.email=tests@example.invalid',
    'commit',
    '-m',
    'legacy baseline',
  );
  const commonAncestor = await git(root, 'rev-parse', 'HEAD');

  await mutateCanonicalTranscript(root, (current) => {
    current.segments[0].words[0].startSeconds = 0;
    current.segments[0].words[1].startSeconds = 1;
  });
  await syncTranscripts({ root });
  await git(root, 'add', '--all');
  await git(
    root,
    '-c',
    'user.name=TrueOutspeak Tests',
    '-c',
    'user.email=tests@example.invalid',
    'commit',
    '-m',
    'reduce anomaly',
  );
  const previousPush = await git(root, 'rev-parse', 'HEAD');

  await git(root, 'checkout', '--detach', commonAncestor);
  await writeFile(join(root, 'README.md'), 'force-pushed branch\n');
  await git(root, 'add', 'README.md');
  await git(
    root,
    '-c',
    'user.name=TrueOutspeak Tests',
    '-c',
    'user.email=tests@example.invalid',
    'commit',
    '-m',
    'reintroduce previous snapshot',
  );

  await assert.doesNotReject(verifyRepository({
    root,
    expectedIds: ['007'],
    baselineRef: previousPush,
    baselineMode: 'merge-base',
  }));
  await assert.rejects(
    verifyRepository({
      root,
      expectedIds: ['007'],
      baselineRef: previousPush,
      baselineMode: 'direct',
    }),
    /ratchet temporal.*wordRegression.*count/i,
  );
});

test('push workflow materializes the non-zero baseline SHA without shell interpolation', async () => {
  const workflow = await readFile(
    join(here, '..', '.github', 'workflows', 'verify.yml'),
    'utf8',
  );
  const expectedStep = [
    '      - name: Materializar baseline anterior do push',
    "        if: github.event_name == 'push' && github.event.before != '0000000000000000000000000000000000000000'",
    '        env:',
    '          PUSH_BASELINE_SHA: ${{ github.event.before }}',
    '        run: git fetch --no-tags --depth=1 origin "$PUSH_BASELINE_SHA"',
  ].join('\n');

  assert.ok(
    workflow.includes(expectedStep),
    'workflow must fetch the push baseline through an environment variable',
  );
  assert.doesNotMatch(
    workflow,
    /run:\s*git fetch[^\n]*\$\{\{/,
    'GitHub context must not be interpolated directly into the shell command',
  );
  assert.ok(
    workflow.indexOf(expectedStep) < workflow.indexOf('- run: npm run verify'),
    'push baseline must be materialized before verification',
  );
});

test('clean clone fetches an unreferenced push baseline before direct ratchet comparison', async () => {
  const source = await mkdtemp(join(tmpdir(), 'trueoutspeak-fetch-source-'));
  const working = await mkdtemp(join(tmpdir(), 'trueoutspeak-fetch-work-'));
  const remote = await mkdtemp(join(tmpdir(), 'trueoutspeak-fetch-remote-'));
  const cloneParent = await mkdtemp(join(tmpdir(), 'trueoutspeak-fetch-clone-'));
  const clone = join(cloneParent, 'repository');
  const transcript = await validTranscript();
  transcript.segments[0].words[0].startSeconds = 1;
  transcript.segments[0].words[1].startSeconds = 0.5;
  await writeFile(
    join(source, 'tos-007.json'),
    `${JSON.stringify(transcript, null, 2)}\n`,
  );
  await exportTranscripts({ source, destination: working });
  await git(working, 'init');
  await git(working, 'add', '--all');
  await git(
    working,
    '-c',
    'user.name=TrueOutspeak Tests',
    '-c',
    'user.email=tests@example.invalid',
    'commit',
    '-m',
    'legacy candidate',
  );
  const commonAncestor = await git(working, 'rev-parse', 'HEAD');

  await mutateCanonicalTranscript(working, (current) => {
    current.segments[0].words[0].startSeconds = 0;
    current.segments[0].words[1].startSeconds = 1;
  });
  await syncTranscripts({ root: working });
  await git(working, 'add', '--all');
  await git(
    working,
    '-c',
    'user.name=TrueOutspeak Tests',
    '-c',
    'user.email=tests@example.invalid',
    'commit',
    '-m',
    'previous push reduced anomaly',
  );
  const previousPush = await git(working, 'rev-parse', 'HEAD');

  await git(remote, 'init', '--bare');
  await git(working, 'remote', 'add', 'origin', pathToFileURL(remote).href);
  await git(working, 'push', 'origin', 'HEAD:refs/hidden/previous-push');
  await git(working, 'checkout', '--detach', commonAncestor);
  await writeFile(join(working, 'README.md'), 'force-pushed candidate\n');
  await git(working, 'add', 'README.md');
  await git(
    working,
    '-c',
    'user.name=TrueOutspeak Tests',
    '-c',
    'user.email=tests@example.invalid',
    'commit',
    '-m',
    'force-pushed reintroduction',
  );
  await git(working, 'push', 'origin', 'HEAD:refs/heads/main');

  await execFile('git', [
    'clone',
    '--branch',
    'main',
    '--single-branch',
    '--depth=1',
    pathToFileURL(remote).href,
    clone,
  ]);
  await assert.rejects(
    git(clone, 'cat-file', '-e', `${previousPush}^{commit}`),
  );

  await git(
    clone,
    'fetch',
    '--no-tags',
    '--depth=1',
    'origin',
    previousPush,
  );
  assert.equal(
    await git(clone, 'cat-file', '-t', previousPush),
    'commit',
  );
  await assert.rejects(
    verifyRepository({
      root: clone,
      expectedIds: ['007'],
      baselineRef: previousPush,
      baselineMode: 'direct',
    }),
    /ratchet temporal.*wordRegression.*count/i,
  );
});

test('zero push baseline uses the default-branch fallback and rejects regression', async () => {
  const root = await createExportRoot();
  await git(root, 'init');
  await git(root, 'add', '--all');
  await git(
    root,
    '-c',
    'user.name=TrueOutspeak Tests',
    '-c',
    'user.email=tests@example.invalid',
    'commit',
    '-m',
    'default branch baseline',
  );
  const fallbackRef = await git(root, 'rev-parse', 'HEAD');
  await mutateCanonicalTranscript(root, (transcript) => {
    transcript.segments[0].words[0].startSeconds = 1;
    transcript.segments[0].words[1].startSeconds = 0.5;
  });
  await syncTranscripts({ root });

  await assert.rejects(
    verifyRepository({
      root,
      expectedIds: ['007'],
      baselineRef: '0000000000000000000000000000000000000000',
      baselineMode: 'direct',
      baselineFallbackRef: fallbackRef,
    }),
    /ratchet temporal.*wordRegression.*count/i,
  );
});

test('zero push baseline permits a true bootstrap when the fallback has no snapshot', async () => {
  const root = await createExportRoot();
  await git(root, 'init');
  await git(root, 'add', '--all');
  await git(root, 'reset', 'temporal-anomalies.json');
  await git(
    root,
    '-c',
    'user.name=TrueOutspeak Tests',
    '-c',
    'user.email=tests@example.invalid',
    'commit',
    '-m',
    'repository before temporal snapshot',
  );
  const fallbackRef = await git(root, 'rev-parse', 'HEAD');
  await git(root, 'add', 'temporal-anomalies.json');

  await assert.doesNotReject(verifyRepository({
    root,
    expectedIds: ['007'],
    baselineRef: '0000000000000000000000000000000000000000',
    baselineMode: 'direct',
    baselineFallbackRef: fallbackRef,
  }));
});

test('rejects any audio file even when it is outside transcript directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-audio-'));
  await exportTranscripts({
    source: join(here, 'fixtures'),
    destination: root,
  });
  await writeFile(join(root, 'proibido.mp3'), Buffer.from('ID3'));

  await assert.rejects(
    verifyRepository({ root, expectedIds: ['007'] }),
    /arquivo de áudio/i,
  );
});

test('rejects headerless MP3 frames disguised with a neutral extension', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-audio-magic-'));
  await exportTranscripts({
    source: join(here, 'fixtures'),
    destination: root,
  });
  await writeFile(
    join(root, 'disfarçado.bin'),
    Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00]),
  );

  await assert.rejects(
    verifyRepository({ root, expectedIds: ['007'] }),
    /arquivo de áudio/i,
  );
});

test('rejects site and image artifacts outside the transcript collection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-site-'));
  await exportTranscripts({
    source: join(here, 'fixtures'),
    destination: root,
  });
  await writeFile(join(root, 'index.html'), '<h1>Site não permitido</h1>');

  await assert.rejects(
    verifyRepository({ root, expectedIds: ['007'] }),
    /artefato de site ou imagem/i,
  );
});

test('rejects every file outside the repository allowlist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-extra-'));
  await exportTranscripts({
    source: join(here, 'fixtures'),
    destination: root,
  });
  await writeFile(join(root, 'anotacoes.txt'), 'Conteúdo extra');

  await assert.rejects(
    verifyRepository({ root, expectedIds: ['007'] }),
    /arquivo não permitido/i,
  );
});

test('does not ignore prohibited files inside node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-node-modules-'));
  await exportTranscripts({
    source: join(here, 'fixtures'),
    destination: root,
  });
  await mkdir(join(root, 'node_modules'));
  await writeFile(
    join(root, 'node_modules', 'oculto.mp3'),
    Buffer.from('ID3'),
  );

  await assert.rejects(
    verifyRepository({ root, expectedIds: ['007'] }),
    /arquivo de áudio/i,
  );
});

test('rejects Markdown that does not exactly match its structured JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-markdown-'));
  await exportTranscripts({
    source: join(here, 'fixtures'),
    destination: root,
  });
  const markdownPath = join(root, 'markdown', 'tos-007.md');
  const markdown = await readFile(markdownPath, 'utf8');
  await writeFile(markdownPath, `${markdown}\nTrecho adulterado.\n`);

  await assert.rejects(
    verifyRepository({ root, expectedIds: ['007'] }),
    /markdown.*diverge/i,
  );
});

test('rejects index metadata that diverges from transcript JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-index-'));
  await exportTranscripts({
    source: join(here, 'fixtures'),
    destination: root,
  });
  const indexPath = join(root, 'indice.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  index.transcripts[0].durationSeconds = 999;
  await writeFile(indexPath, JSON.stringify(index));

  await assert.rejects(
    verifyRepository({ root, expectedIds: ['007'] }),
    /índice.*diverge/i,
  );
});

test('rejects a self-consistent export containing invalid transcript metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-invalid-json-'));
  await exportTranscripts({
    source: join(here, 'fixtures'),
    destination: root,
  });
  const jsonPath = join(root, 'json', 'tos-007.json');
  const markdownPath = join(root, 'markdown', 'tos-007.md');
  const transcript = JSON.parse(await readFile(jsonPath, 'utf8'));
  transcript.source = '';
  await writeFile(jsonPath, JSON.stringify(transcript));
  await writeFile(markdownPath, renderMarkdown(transcript));

  const indexPath = join(root, 'indice.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  index.transcripts[0].source = '';
  await writeFile(indexPath, JSON.stringify(index));

  const manifestLines = [];
  for (const relativePath of [
    'json/tos-007.json',
    'markdown/tos-007.md',
  ]) {
    const content = await readFile(join(root, relativePath));
    const hash = createHash('sha256').update(content).digest('hex');
    manifestLines.push(`${hash}  ${relativePath}`);
  }
  await writeFile(
    join(root, 'MANIFEST.sha256'),
    `${manifestLines.join('\n')}\n`,
  );

  await assert.rejects(
    verifyRepository({ root, expectedIds: ['007'] }),
    /json inválido/i,
  );
});

test('rejects self-consistent corruption of segment word metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-invalid-word-'));
  await exportTranscripts({
    source: join(here, 'fixtures'),
    destination: root,
  });
  const jsonPath = join(root, 'json', 'tos-007.json');
  const transcript = JSON.parse(await readFile(jsonPath, 'utf8'));
  transcript.segments[0].words[0].text = '';
  await writeFile(jsonPath, JSON.stringify(transcript));

  const manifestLines = [];
  for (const relativePath of [
    'json/tos-007.json',
    'markdown/tos-007.md',
  ]) {
    const content = await readFile(join(root, relativePath));
    const hash = createHash('sha256').update(content).digest('hex');
    manifestLines.push(`${hash}  ${relativePath}`);
  }
  await writeFile(
    join(root, 'MANIFEST.sha256'),
    `${manifestLines.join('\n')}\n`,
  );

  await assert.rejects(
    verifyRepository({ root, expectedIds: ['007'] }),
    /json inválido/i,
  );
});

test('rejects additional audio signatures in an otherwise allowed path', async (t) => {
  const signatures = new Map([
    ['CAF', Buffer.from('caff')],
    ['AC-3', Buffer.from([0x0b, 0x77, 0x00, 0x00])],
    ['DTS', Buffer.from([0x7f, 0xfe, 0x80, 0x01])],
    ['RealAudio', Buffer.from([0x2e, 0x72, 0x61, 0xfd])],
    ['WavPack', Buffer.from('wvpk')],
    ['TTA', Buffer.from('TTA1')],
  ]);

  for (const [name, signature] of signatures) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-signature-'));
      await exportTranscripts({
        source: join(here, 'fixtures'),
        destination: root,
      });
      await mkdir(join(root, 'scripts'));
      await writeFile(join(root, 'scripts', 'export.mjs'), signature);

      await assert.rejects(
        verifyRepository({ root, expectedIds: ['007'] }),
        /arquivo de áudio/i,
      );
    });
  }
});

test('rejects repository files above the configured size limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-size-'));
  await exportTranscripts({
    source: join(here, 'fixtures'),
    destination: root,
  });
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts', 'export.mjs'), 'x'.repeat(64));

  await assert.rejects(
    verifyRepository({
      root,
      expectedIds: ['007'],
      maxFileBytes: 32,
    }),
    /limite de tamanho/i,
  );
});

test('rejects repositories above the configured total size limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trueoutspeak-total-size-'));
  await exportTranscripts({
    source: join(here, 'fixtures'),
    destination: root,
  });

  await assert.rejects(
    verifyRepository({
      root,
      expectedIds: ['007'],
      maxFileBytes: Number.MAX_SAFE_INTEGER,
      maxTotalBytes: 32,
    }),
    /limite de tamanho total/i,
  );
});
