import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertTranscript,
  renderMarkdown,
} from './export.mjs';

const transcriptName = /^tos-(\d{3})\.json$/;
const derivedNames = ['markdown', 'indice.json', 'MANIFEST.sha256'];

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
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

async function currentBuffer(path) {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function listMarkdownFiles(root, relative = 'markdown') {
  const path = join(root, relative);
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return [relative];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(root, child));
    } else {
      files.push(child);
    }
  }
  return files;
}

async function promoteStagedArtifacts({ root, stagingDirectory }) {
  const backupDirectory = join(
    root,
    `.trueoutspeak-sync-backup-${randomUUID()}`,
  );
  const backedUp = [];
  const promoted = [];
  await mkdir(backupDirectory);

  try {
    for (const name of derivedNames) {
      const target = join(root, name);
      if (await exists(target)) {
        await rename(target, join(backupDirectory, name));
        backedUp.push(name);
      }
    }

    for (const name of derivedNames) {
      await rename(join(stagingDirectory, name), join(root, name));
      promoted.push(name);
    }
  } catch (error) {
    for (const name of promoted.reverse()) {
      await rm(join(root, name), { recursive: true, force: true });
    }
    for (const name of backedUp.reverse()) {
      await rename(join(backupDirectory, name), join(root, name));
    }
    throw error;
  } finally {
    await rm(backupDirectory, { recursive: true, force: true });
  }
}

export async function syncTranscripts({ root, check = false }) {
  const repositoryRoot = resolve(root);
  const jsonDirectory = join(repositoryRoot, 'json');
  const files = (await readdir(jsonDirectory))
    .filter((filename) => transcriptName.test(filename))
    .sort((left, right) => left.localeCompare(right, 'en'));
  const stagingDirectory = join(
    repositoryRoot,
    `.trueoutspeak-sync-stage-${randomUUID()}`,
  );
  const stagingMarkdownDirectory = join(stagingDirectory, 'markdown');
  const expected = new Map();
  const transcripts = [];
  const manifest = [];

  await mkdir(stagingMarkdownDirectory, { recursive: true });
  try {
    for (const filename of files) {
      const id = transcriptName.exec(filename)[1];
      const jsonPath = join(jsonDirectory, filename);
      const jsonContent = await readFile(jsonPath);
      const transcript = JSON.parse(jsonContent.toString('utf8'));
      assertTranscript(transcript, filename);
      if (transcript.episodeId !== id) {
        throw new Error(
          `ID ${transcript.episodeId} não corresponde ao arquivo ${filename}`,
        );
      }

      const markdownPath = `markdown/tos-${id}.md`;
      const markdownContent = Buffer.from(renderMarkdown(transcript), 'utf8');
      await writeFile(join(stagingDirectory, markdownPath), markdownContent);
      expected.set(markdownPath, markdownContent);
      manifest.push(
        { path: `json/${filename}`, hash: sha256(jsonContent) },
        { path: markdownPath, hash: sha256(markdownContent) },
      );
      transcripts.push({
        id,
        code: `TOS-${id}`,
        source: transcript.source,
        durationSeconds: transcript.durationSeconds,
        json: `json/${filename}`,
        markdown: markdownPath,
      });
    }

    const indexContent = Buffer.from(
      `${JSON.stringify({
        schemaVersion: 1,
        total: transcripts.length,
        transcripts,
      }, null, 2)}\n`,
      'utf8',
    );
    const manifestContent = Buffer.from(
      `${manifest
        .sort((left, right) => left.path.localeCompare(right.path, 'en'))
        .map(({ hash, path }) => `${hash}  ${path}`)
        .join('\n')}\n`,
      'utf8',
    );
    await writeFile(join(stagingDirectory, 'indice.json'), indexContent);
    await writeFile(join(stagingDirectory, 'MANIFEST.sha256'), manifestContent);
    expected.set('indice.json', indexContent);
    expected.set('MANIFEST.sha256', manifestContent);

    const changed = [];
    for (const [relativePath, content] of expected) {
      const current = await currentBuffer(join(repositoryRoot, relativePath));
      if (!current || !current.equals(content)) changed.push(relativePath);
    }
    const expectedMarkdownPaths = new Set(
      [...expected.keys()].filter((path) => path.startsWith('markdown/')),
    );
    for (const relativePath of await listMarkdownFiles(repositoryRoot)) {
      if (!expectedMarkdownPaths.has(relativePath)) changed.push(relativePath);
    }
    changed.sort();

    if (!check && changed.length > 0) {
      await promoteStagedArtifacts({ root: repositoryRoot, stagingDirectory });
    }

    return { changed, transcripts: transcripts.length };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = { root: '.', check: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--check') options.check = true;
    else if (argv[index] === '--root') options.root = argv[++index];
    else throw new Error(`Argumento desconhecido: ${argv[index]}`);
  }
  if (!options.root) throw new Error('O argumento --root exige um diretório.');
  return options;
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  const options = parseArguments(process.argv.slice(2));
  const result = await syncTranscripts(options);
  if (options.check && result.changed.length > 0) {
    console.error(`Artefatos derivados divergentes: ${result.changed.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`${result.transcripts} transcrições sincronizadas.`);
  }
}
