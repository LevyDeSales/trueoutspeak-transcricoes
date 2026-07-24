import {
  lstat,
  open,
  readFile,
  readdir,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertTranscript,
  renderMarkdown,
} from './export.mjs';

const audioExtensions = new Set([
  '.3g2',
  '.3gp',
  '.ac3',
  '.aac',
  '.aif',
  '.ape',
  '.aiff',
  '.amr',
  '.au',
  '.caf',
  '.flac',
  '.m4a',
  '.m4b',
  '.mka',
  '.mkv',
  '.mid',
  '.midi',
  '.mp3',
  '.mp1',
  '.mp2',
  '.mp4',
  '.mpa',
  '.mpc',
  '.mpeg',
  '.mpg',
  '.oga',
  '.ogg',
  '.opus',
  '.ra',
  '.ram',
  '.rm',
  '.spx',
  '.tta',
  '.webm',
  '.weba',
  '.wav',
  '.wma',
  '.wv',
]);
const siteOrImageExtensions = new Set([
  '.avif',
  '.css',
  '.eot',
  '.gif',
  '.htm',
  '.html',
  '.ico',
  '.jpeg',
  '.jpg',
  '.otf',
  '.png',
  '.svg',
  '.ttf',
  '.webp',
  '.woff',
  '.woff2',
]);
const ignoredDirectories = new Set(['.git']);
const supportFiles = new Set([
  '.github/workflows/verify.yml',
  '.gitignore',
  '.nvmrc',
  'MANIFEST.sha256',
  'README.md',
  'indice.json',
  'package-lock.json',
  'package.json',
  'scripts/export.mjs',
  'scripts/sync.mjs',
  'scripts/verify.mjs',
  'tests/export.test.mjs',
  'tests/fixtures/tos-007.json',
  'tests/sync.test.mjs',
  'tests/verify.test.mjs',
  'docs/superpowers/plans/2026-07-24-contribution-workflow.md',
  'docs/superpowers/specs/2026-07-24-contribution-workflow-design.md',
]);

function isAllowedFile(relativePath) {
  return (
    supportFiles.has(relativePath) ||
    /^json\/tos-\d{3}\.json$/.test(relativePath) ||
    /^markdown\/tos-\d{3}\.md$/.test(relativePath)
  );
}

async function listFiles(root, relative = '') {
  const directory = join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...await listFiles(root, path));
      }
    } else {
      const stats = await lstat(join(root, path));
      if (stats.isSymbolicLink()) {
        throw new Error(`Link simbólico não permitido: ${path}`);
      }
      files.push(path);
    }
  }
  return files;
}

async function hasAudioSignature(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead);
    const ascii = header.toString('ascii');
    const startsWithBytes = (...bytes) =>
      bytes.every((byte, index) => header[index] === byte);
    return (
      ascii.startsWith('ID3') ||
      ascii.startsWith('OggS') ||
      ascii.startsWith('fLaC') ||
      ascii.startsWith('#!AMR') ||
      ascii.startsWith('MAC ') ||
      ascii.startsWith('TTA1') ||
      ascii.startsWith('caff') ||
      ascii.startsWith('wvpk') ||
      ascii.startsWith('MThd') ||
      ascii.startsWith('.snd') ||
      startsWithBytes(0x0b, 0x77) ||
      startsWithBytes(0x7f, 0xfe, 0x80, 0x01) ||
      startsWithBytes(0xfe, 0x7f, 0x01, 0x80) ||
      startsWithBytes(0x1f, 0xff, 0xe8, 0x00) ||
      startsWithBytes(0xff, 0x1f, 0x00, 0xe8) ||
      startsWithBytes(0x2e, 0x72, 0x61, 0xfd) ||
      (header[0] === 0xff && (header[1] & 0xe0) === 0xe0) ||
      (
        header.length >= 4 &&
        header[0] === 0x1a &&
        header[1] === 0x45 &&
        header[2] === 0xdf &&
        header[3] === 0xa3
      ) ||
      (
        header.length >= 4 &&
        header[0] === 0x30 &&
        header[1] === 0x26 &&
        header[2] === 0xb2 &&
        header[3] === 0x75
      ) ||
      (
        ascii.startsWith('FORM') &&
        ['AIFF', 'AIFC'].includes(ascii.slice(8, 12))
      ) ||
      (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') ||
      (header.length >= 8 && ascii.slice(4, 8) === 'ftyp')
    );
  } finally {
    await handle.close();
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function expectedTranscriptIds() {
  return Array.from(
    { length: 296 },
    (_, index) => String(index + 1).padStart(3, '0'),
  );
}

export async function verifyRepository({
  root,
  expectedIds = expectedTranscriptIds(),
  maxFileBytes = 50 * 1024 * 1024,
  maxTotalBytes = 1024 * 1024 * 1024,
}) {
  const repositoryRoot = resolve(root);
  const files = await listFiles(repositoryRoot);
  const audioFiles = [];
  let totalBytes = 0;

  for (const relativePath of files) {
    const stats = await lstat(join(repositoryRoot, relativePath));
    totalBytes += stats.size;
    if (stats.size > maxFileBytes) {
      throw new Error(
        `Limite de tamanho por arquivo excedido: ${relativePath}`,
      );
    }
  }
  if (totalBytes > maxTotalBytes) {
    throw new Error('Limite de tamanho total do repositório excedido.');
  }

  const siteOrImageFiles = files.filter((relativePath) =>
    siteOrImageExtensions.has(extname(relativePath).toLowerCase())
  );

  if (siteOrImageFiles.length > 0) {
    throw new Error(
      `Artefato de site ou imagem proibido: ${siteOrImageFiles.join(', ')}`,
    );
  }

  for (const relativePath of files) {
    const extension = extname(relativePath).toLowerCase();
    if (
      audioExtensions.has(extension) ||
      await hasAudioSignature(join(repositoryRoot, relativePath))
    ) {
      audioFiles.push(relativePath);
    }
  }

  if (audioFiles.length > 0) {
    throw new Error(
      `Arquivo de áudio proibido encontrado: ${audioFiles.join(', ')}`,
    );
  }

  const unexpectedFiles = files.filter((path) => !isAllowedFile(path));
  if (unexpectedFiles.length > 0) {
    throw new Error(
      `Arquivo não permitido no repositório: ${unexpectedFiles.join(', ')}`,
    );
  }

  const index = JSON.parse(
    await readFile(join(repositoryRoot, 'indice.json'), 'utf8'),
  );
  const actualIds = index.transcripts?.map((item) => item.id) ?? [];
  if (
    index.schemaVersion !== 1 ||
    index.total !== expectedIds.length ||
    JSON.stringify(actualIds) !== JSON.stringify(expectedIds)
  ) {
    throw new Error('Índice incompleto ou fora de ordem.');
  }

  const jsonFiles = files
    .filter((path) => /^json\/tos-\d{3}\.json$/.test(path))
    .sort();
  const markdownFiles = files
    .filter((path) => /^markdown\/tos-\d{3}\.md$/.test(path))
    .sort();

  if (
    jsonFiles.length !== expectedIds.length ||
    markdownFiles.length !== expectedIds.length
  ) {
    throw new Error('Quantidade de arquivos de transcrição incorreta.');
  }

  const expectedIndex = {
    schemaVersion: 1,
    total: expectedIds.length,
    transcripts: [],
  };

  for (const id of expectedIds) {
    const jsonPath = join(repositoryRoot, 'json', `tos-${id}.json`);
    const markdownPath = join(repositoryRoot, 'markdown', `tos-${id}.md`);
    const jsonContent = await readFile(jsonPath);
    const transcript = JSON.parse(jsonContent.toString('utf8'));
    const markdown = await readFile(markdownPath, 'utf8');

    try {
      assertTranscript(transcript, `tos-${id}.json`);
    } catch (error) {
      throw new Error(`JSON inválido para TOS-${id}: ${error.message}`);
    }

    if (
      transcript.episodeId !== id ||
      typeof transcript.fullText !== 'string' ||
      transcript.fullText.trim() === '' ||
      !Array.isArray(transcript.segments) ||
      transcript.segments.length === 0
    ) {
      throw new Error(`JSON inválido para TOS-${id}.`);
    }
    if (markdown !== renderMarkdown(transcript)) {
      throw new Error(`Markdown diverge do JSON para TOS-${id}.`);
    }

    expectedIndex.transcripts.push({
      id,
      code: `TOS-${id}`,
      source: transcript.source,
      durationSeconds: transcript.durationSeconds,
      json: `json/tos-${id}.json`,
      markdown: `markdown/tos-${id}.md`,
    });
  }

  if (JSON.stringify(index) !== JSON.stringify(expectedIndex)) {
    throw new Error('Índice diverge dos metadados das transcrições.');
  }

  const expectedManifest = [];
  for (const relativePath of [...jsonFiles, ...markdownFiles].sort()) {
    const content = await readFile(join(repositoryRoot, relativePath));
    expectedManifest.push(`${sha256(content)}  ${relativePath}`);
  }
  const manifest = await readFile(
    join(repositoryRoot, 'MANIFEST.sha256'),
    'utf8',
  );
  if (manifest !== `${expectedManifest.join('\n')}\n`) {
    throw new Error('Manifesto SHA-256 diverge dos arquivos de transcrição.');
  }

  return {
    transcripts: expectedIds.length,
    markdownFiles: markdownFiles.length,
    jsonFiles: jsonFiles.length,
    audioFiles: audioFiles.length,
  };
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex === -1 ? '.' : process.argv[rootIndex + 1];
  if (!root) throw new Error('O argumento --root exige um diretório.');
  const report = await verifyRepository({ root });
  console.log(JSON.stringify(report, null, 2));
}
