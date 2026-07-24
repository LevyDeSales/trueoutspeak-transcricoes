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
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  exportTranscripts,
  renderMarkdown,
} from '../scripts/export.mjs';
import { verifyRepository } from '../scripts/verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const execFile = promisify(execFileCallback);

async function git(root, ...args) {
  await execFile('git', ['-C', root, ...args]);
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

test('ignores untracked scratch files ignored by Git', async () => {
  const root = await createGitRepository();
  await mkdir(join(root, '.superpowers', 'sdd'), { recursive: true });
  await writeFile(join(root, '.superpowers', 'sdd', 'scratch.md'), 'local');

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
