import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const transcriptName = /^tos-(\d{3})\.json$/;

function roundedDelta(seconds) {
  return Number(seconds.toFixed(9));
}

function recordTemporalAnomaly(anomalies, name, delta) {
  const current = anomalies[name] ?? {
    count: 0,
    worstDeltaSeconds: 0,
  };
  current.count += 1;
  current.worstDeltaSeconds = Math.max(
    current.worstDeltaSeconds,
    roundedDelta(delta),
  );
  anomalies[name] = current;
}

export function temporalAnomaliesForTranscript(transcript) {
  const segments = {};

  for (const segment of transcript.segments) {
    const anomalies = {};
    let previousWordTimestamp = -Infinity;
    for (const word of segment.words) {
      if (word.startSeconds < previousWordTimestamp) {
        recordTemporalAnomaly(
          anomalies,
          'wordRegression',
          previousWordTimestamp - word.startSeconds,
        );
      }
      if (word.startSeconds < segment.startSeconds) {
        recordTemporalAnomaly(
          anomalies,
          'beforeSegment',
          segment.startSeconds - word.startSeconds,
        );
      }
      if (word.startSeconds > segment.endSeconds) {
        recordTemporalAnomaly(
          anomalies,
          'afterSegment',
          word.startSeconds - segment.endSeconds,
        );
      }
      if (word.startSeconds > transcript.durationSeconds) {
        recordTemporalAnomaly(
          anomalies,
          'outsideDuration',
          word.startSeconds - transcript.durationSeconds,
        );
      }
      previousWordTimestamp = word.startSeconds;
    }
    if (Object.keys(anomalies).length > 0) {
      segments[segment.id] = anomalies;
    }
  }

  return segments;
}

export function temporalAnomalyProfile(transcripts) {
  const episodes = {};
  for (const transcript of transcripts) {
    const segments = temporalAnomaliesForTranscript(transcript);
    if (Object.keys(segments).length > 0) {
      episodes[transcript.episodeId] = segments;
    }
  }
  return { schemaVersion: 1, episodes };
}

function hasExactKeys(value, expectedKeys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expectedKeys].sort())
  );
}

function formatTimestamp(seconds) {
  const wholeSeconds = Math.max(0, Math.floor(Number(seconds)));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainder = wholeSeconds % 60;
  return [hours, minutes, remainder]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

export function assertTranscript(transcript, filename) {
  if (
    !hasExactKeys(transcript, [
      'schemaVersion',
      'episodeId',
      'source',
      'durationSeconds',
      'fullText',
      'segments',
    ]) ||
    transcript?.schemaVersion !== 1 ||
    !/^(00[1-9]|0[1-9]\d|1\d{2}|2[0-8]\d|29[0-6])$/.test(
      transcript?.episodeId,
    ) ||
    typeof transcript?.source !== 'string' ||
    transcript.source.trim() === '' ||
    !Number.isFinite(transcript?.durationSeconds) ||
    transcript.durationSeconds <= 0 ||
    typeof transcript?.fullText !== 'string' ||
    transcript.fullText.trim() === '' ||
    !Array.isArray(transcript?.segments) ||
    transcript.segments.length === 0
  ) {
    throw new Error(`Transcrição inválida: ${filename}`);
  }

  const segmentIds = new Set();
  let previousSegmentNumber = -Infinity;
  for (const segment of transcript.segments) {
    if (
      !hasExactKeys(segment, [
        'id',
        'startSeconds',
        'endSeconds',
        'text',
        'words',
      ]) ||
      !/^seg-\d{4,}$/.test(segment?.id) ||
      !Number.isFinite(segment?.startSeconds) ||
      !Number.isFinite(segment?.endSeconds) ||
      segment.startSeconds < 0 ||
      segment.endSeconds < segment.startSeconds ||
      typeof segment?.text !== 'string' ||
      segment.text.trim() === '' ||
      !Array.isArray(segment?.words) ||
      segment.words.length === 0
    ) {
      throw new Error(`Segmento inválido: ${filename}`);
    }

    if (segmentIds.has(segment.id)) {
      throw new Error(
        `IDs de segmento devem ser únicos: ${filename}`,
      );
    }
    const segmentNumber = Number(segment.id.slice(4));
    if (segmentNumber <= previousSegmentNumber) {
      throw new Error(
        `IDs de segmento devem estar em ordem crescente: ${filename}`,
      );
    }
    segmentIds.add(segment.id);
    previousSegmentNumber = segmentNumber;

    for (const word of segment.words) {
      if (
        !hasExactKeys(word, ['startSeconds', 'text']) ||
        !Number.isFinite(word?.startSeconds) ||
        word.startSeconds < 0 ||
        typeof word?.text !== 'string' ||
        word.text.trim() === ''
      ) {
        throw new Error(`Palavra inválida: ${filename}`);
      }
    }

    if (segment.text !== segment.words.map(({ text }) => text).join(' ')) {
      throw new Error(
        `Texto do segmento deve ser derivado das palavras: ${filename}`,
      );
    }
    if (
      segment.startSeconds > transcript.durationSeconds ||
      segment.endSeconds > transcript.durationSeconds
    ) {
      throw new Error(
        `Timestamp de segmento deve ficar dentro da duração: ${filename}`,
      );
    }
  }

  if (
    transcript.fullText !==
    transcript.segments.map(({ text }) => text).join('\n')
  ) {
    throw new Error(
      `Texto completo deve ser derivado dos segmentos: ${filename}`,
    );
  }
}

export function renderMarkdown(transcript) {
  const code = `TOS-${transcript.episodeId}`;
  const duration = formatTimestamp(transcript.durationSeconds);
  const lines = [
    `# ${code} — Transcrição`,
    '',
    `- Fonte da transcrição: ${transcript.source}`,
    `- Duração aproximada: ${duration}`,
    '',
    '## Texto com marcações de tempo',
    '',
  ];

  for (const segment of transcript.segments) {
    lines.push(
      `**[${formatTimestamp(segment.startSeconds)}]** ${segment.text.trim()}`,
      '',
    );
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function pathsOverlap(left, right) {
  const difference = relative(left, right);
  return (
    difference === '' ||
    (
      difference !== '..' &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference)
    )
  );
}

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

async function promoteStagedExport({
  destinationDirectory,
  stagingDirectory,
  names,
}) {
  const backupDirectory = join(
    destinationDirectory,
    `.trueoutspeak-export-backup-${randomUUID()}`,
  );
  const backedUp = [];
  const promoted = [];
  await mkdir(backupDirectory);

  try {
    for (const name of names) {
      const target = join(destinationDirectory, name);
      if (await exists(target)) {
        await rename(target, join(backupDirectory, name));
        backedUp.push(name);
      }
    }

    for (const name of names) {
      await rename(
        join(stagingDirectory, name),
        join(destinationDirectory, name),
      );
      promoted.push(name);
    }
  } catch (error) {
    for (const name of promoted.reverse()) {
      await rm(join(destinationDirectory, name), {
        recursive: true,
        force: true,
      });
    }
    for (const name of backedUp.reverse()) {
      await rename(
        join(backupDirectory, name),
        join(destinationDirectory, name),
      );
    }
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
    await rm(backupDirectory, { recursive: true, force: true });
  }
}

export async function exportTranscripts({ source, destination }) {
  const sourceDirectory = resolve(source);
  const destinationDirectory = resolve(destination);
  await mkdir(destinationDirectory, { recursive: true });
  const physicalSource = await realpath(sourceDirectory);
  const physicalDestination = await realpath(destinationDirectory);
  const comparableSource = ['darwin', 'win32'].includes(process.platform)
    ? physicalSource.toLowerCase()
    : physicalSource;
  const comparableDestination = ['darwin', 'win32'].includes(process.platform)
    ? physicalDestination.toLowerCase()
    : physicalDestination;
  if (
    pathsOverlap(comparableSource, comparableDestination) ||
    pathsOverlap(comparableDestination, comparableSource)
  ) {
    throw new Error(
      'Os diretórios de origem e destino se sobrepõem; use locais independentes.',
    );
  }

  const files = (await readdir(sourceDirectory))
    .filter((filename) => transcriptName.test(filename))
    .sort((left, right) => left.localeCompare(right, 'en'));

  const stagingDirectory = join(
    destinationDirectory,
    `.trueoutspeak-export-stage-${randomUUID()}`,
  );
  const jsonDirectory = join(stagingDirectory, 'json');
  const markdownDirectory = join(stagingDirectory, 'markdown');
  await mkdir(jsonDirectory, { recursive: true });
  await mkdir(markdownDirectory, { recursive: true });

  const transcripts = [];
  const transcriptDocuments = [];
  const manifest = [];

  try {
    for (const filename of files) {
      const match = transcriptName.exec(filename);
      const id = match[1];
      const sourcePath = join(sourceDirectory, filename);
      const jsonContent = await readFile(sourcePath);
      const transcript = JSON.parse(jsonContent.toString('utf8'));
      assertTranscript(transcript, filename);

      if (transcript.episodeId !== id) {
        throw new Error(
          `ID ${transcript.episodeId} não corresponde ao arquivo ${filename}`,
        );
      }

      const markdownContent = Buffer.from(renderMarkdown(transcript), 'utf8');
      await writeFile(join(jsonDirectory, filename), jsonContent);
      await writeFile(
        join(markdownDirectory, `tos-${id}.md`),
        markdownContent,
      );

      manifest.push(
        {
          path: `json/${filename}`,
          hash: sha256(jsonContent),
        },
        {
          path: `markdown/tos-${id}.md`,
          hash: sha256(markdownContent),
        },
      );

      transcripts.push({
        id,
        code: `TOS-${id}`,
        source: transcript.source,
        durationSeconds: transcript.durationSeconds,
        json: `json/${filename}`,
        markdown: `markdown/tos-${id}.md`,
      });
      transcriptDocuments.push(transcript);
    }

    const index = {
      schemaVersion: 1,
      total: transcripts.length,
      transcripts,
    };
    await writeFile(
      join(stagingDirectory, 'indice.json'),
      `${JSON.stringify(index, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      join(stagingDirectory, 'MANIFEST.sha256'),
      `${manifest
        .sort((left, right) => left.path.localeCompare(right.path, 'en'))
        .map(({ hash, path }) => `${hash}  ${path}`)
        .join('\n')}\n`,
      'utf8',
    );
    await writeFile(
      join(stagingDirectory, 'temporal-anomalies.json'),
      `${JSON.stringify(
        temporalAnomalyProfile(transcriptDocuments),
        null,
        2,
      )}\n`,
      'utf8',
    );

    await promoteStagedExport({
      destinationDirectory,
      stagingDirectory,
      names: [
        'json',
        'markdown',
        'indice.json',
        'MANIFEST.sha256',
        'temporal-anomalies.json',
      ],
    });
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    count: transcripts.length,
    ids: transcripts.map((transcript) => transcript.id),
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--source') options.source = argv[++index];
    else if (argv[index] === '--destination') {
      options.destination = argv[++index];
    } else {
      throw new Error(`Argumento desconhecido: ${argv[index]}`);
    }
  }

  if (!options.source || !options.destination) {
    throw new Error(
      'Uso: node scripts/export.mjs --source <diretório> --destination <diretório>',
    );
  }
  return options;
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  const result = await exportTranscripts(parseArguments(process.argv.slice(2)));
  console.log(`Exportadas ${result.count} transcrições.`);
}
