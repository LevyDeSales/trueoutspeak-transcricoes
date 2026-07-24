import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { assertTranscript } from './export.mjs';
import { syncTranscripts } from './sync.mjs';

function wordsFromText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('O texto de substituição é obrigatório.');
  }
  return text.trim().split(/\s+/);
}

function matchingSegments(transcript, selector) {
  if (!selector || typeof selector !== 'object') {
    throw new Error('Informe um seletor de segmento.');
  }
  const supplied = ['id', 'timestamp', 'excerpt']
    .filter((key) => selector[key] !== undefined);
  if (supplied.length !== 1) {
    throw new Error('Informe exatamente um seletor de segmento.');
  }

  const key = supplied[0];
  if (key === 'id') {
    return transcript.segments.filter((segment) => segment.id === selector.id);
  }
  if (key === 'timestamp') {
    if (!Number.isFinite(selector.timestamp)) {
      throw new Error('O tempo deve ser um número válido de segundos.');
    }
    return transcript.segments.filter((segment) => (
      selector.timestamp >= segment.startSeconds
      && selector.timestamp <= segment.endSeconds
    ));
  }
  if (typeof selector.excerpt !== 'string' || selector.excerpt.trim() === '') {
    throw new Error('O trecho deve ser texto não vazio.');
  }
  const excerpt = selector.excerpt.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
  return transcript.segments.filter((segment) => (
    segment.text.replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR').includes(excerpt)
  ));
}

export function findSegment(transcript, selector) {
  const matches = matchingSegments(transcript, selector);
  if (matches.length === 0) throw new Error('Nenhum segmento corresponde ao seletor.');
  if (matches.length > 1) throw new Error('O seletor é ambíguo; informe um segmento único.');
  return matches[0];
}

function validateExplicitWords({ words, replacementWords, segment, durationSeconds }) {
  if (!Array.isArray(words) || words.length === 0) {
    throw new Error('Uma alteração de contagem exige words[] explícito.');
  }
  if (words.length !== replacementWords.length) {
    throw new Error('words[] deve corresponder à contagem de palavras do texto.');
  }
  let previousTimestamp = -Infinity;
  for (const [index, word] of words.entries()) {
    if (
      !word
      || typeof word !== 'object'
      || Array.isArray(word)
      || Object.keys(word).length !== 2
      || !Object.hasOwn(word, 'startSeconds')
      || !Object.hasOwn(word, 'text')
      || !Number.isFinite(word.startSeconds)
      || word.startSeconds < 0
      || typeof word.text !== 'string'
      || word.text.trim() === ''
      || word.text !== replacementWords[index]
    ) {
      throw new Error('words[] deve conter timestamps e textos válidos que correspondam ao texto.');
    }
    if (word.startSeconds > durationSeconds) {
      throw new Error('words[] não pode conter timestamps após a duração da transcrição.');
    }
    if (word.startSeconds < segment.startSeconds || word.startSeconds > segment.endSeconds) {
      throw new Error('words[] deve conter timestamps dentro do segmento.');
    }
    if (word.startSeconds < previousTimestamp) {
      throw new Error('words[] deve conter timestamps em ordem não decrescente.');
    }
    previousTimestamp = word.startSeconds;
  }
}

export function applyCorrection(transcript, correction) {
  const updated = structuredClone(transcript);
  const segment = findSegment(updated, correction?.selector);
  if (typeof correction?.expectedText !== 'string' || correction.expectedText !== segment.text) {
    throw new Error('O texto esperado não corresponde ao segmento atual.');
  }

  const replacementWords = wordsFromText(correction.text);
  const countChanged = replacementWords.length !== segment.words.length;
  const hasExplicitWords = correction.words !== undefined;
  if (countChanged && !hasExplicitWords) {
    throw new Error('Uma alteração de contagem exige words[] explícito.');
  }
  if (hasExplicitWords) {
    validateExplicitWords({
      words: correction.words,
      replacementWords,
      segment,
      durationSeconds: updated.durationSeconds,
    });
    const timestampsChanged = countChanged || segment.words.some((word, index) => (
      word.startSeconds !== correction.words[index].startSeconds
    ));
    segment.words = structuredClone(correction.words);
    segment.text = segment.words.map(({ text }) => text).join(' ');
    updated.fullText = updated.segments.map(({ text }) => text).join('\n');
    assertTranscript(updated, `tos-${updated.episodeId}.json`);
    return {
      transcript: updated,
      requiresHumanReview: countChanged || timestampsChanged,
    };
  } else {
    segment.words = segment.words.map((word, index) => ({
      ...word,
      text: replacementWords[index],
    }));
  }

  segment.text = segment.words.map(({ text }) => text).join(' ');
  updated.fullText = updated.segments.map(({ text }) => text).join('\n');
  assertTranscript(updated, `tos-${updated.episodeId}.json`);
  return { transcript: updated, requiresHumanReview: false };
}

async function atomicWrite(path, content) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, 'utf8');
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function atomicWriteJson(path, transcript) {
  await atomicWrite(path, `${JSON.stringify(transcript, null, 2)}\n`);
}

function preview({ before, after, requiresHumanReview }) {
  const lines = [
    'Prévia da correção:',
    `- Antes: ${before.text}`,
    `- Depois: ${after.text}`,
  ];
  if (requiresHumanReview) {
    lines.push('- Revisão humana obrigatória: a contagem de palavras ou a marcação temporal mudou.');
  }
  return lines.join('\n');
}

export async function runCorrection({
  root = '.',
  episode,
  selector,
  expectedText,
  text,
  words,
  confirm,
  output = console.log,
  write = atomicWriteJson,
  sync = syncTranscripts,
}) {
  if (!/^(00[1-9]|0[1-9]\d|1\d{2}|2[0-8]\d|29[0-6])$/.test(episode ?? '')) {
    throw new Error('O episódio deve ter três dígitos entre 001 e 296.');
  }
  const repositoryRoot = resolve(root);
  const path = join(repositoryRoot, 'json', `tos-${episode}.json`);
  const originalContent = await readFile(path);
  const transcript = JSON.parse(originalContent.toString('utf8'));
  assertTranscript(transcript, `tos-${episode}.json`);
  const before = findSegment(transcript, selector);
  const result = applyCorrection(transcript, {
    selector,
    expectedText,
    text,
    words,
  });
  const after = findSegment(result.transcript, { id: before.id });
  output(preview({ before, after, requiresHumanReview: result.requiresHumanReview }));

  if (!await confirm()) {
    output('Correção cancelada; nenhum arquivo foi alterado.');
    return { written: false, requiresHumanReview: result.requiresHumanReview };
  }

  await write(path, result.transcript);
  try {
    await sync({ root: repositoryRoot });
  } catch (error) {
    await atomicWrite(path, originalContent);
    throw error;
  }
  output('Correção gravada e artefatos derivados sincronizados.');
  return { written: true, requiresHumanReview: result.requiresHumanReview };
}

function readOption(argv, index) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${argv[index]} exige um valor.`);
  }
  return value;
}

export function parseArguments(argv) {
  const options = { root: '.', assumeYes: false };
  const selectors = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--sim') options.assumeYes = true;
    else if (argument === '--episodio') options.episode = readOption(argv, index++);
    else if (argument === '--segmento') {
      options.selector = { id: readOption(argv, index++) };
      selectors.push('id');
    } else if (argument === '--tempo') {
      options.selector = { timestamp: Number(readOption(argv, index++)) };
      selectors.push('timestamp');
    } else if (argument === '--trecho') {
      options.selector = { excerpt: readOption(argv, index++) };
      selectors.push('excerpt');
    } else if (argument === '--esperado') options.expectedText = readOption(argv, index++);
    else if (argument === '--texto') options.text = readOption(argv, index++);
    else if (argument === '--palavras-json') {
      try {
        options.words = JSON.parse(readOption(argv, index++));
      } catch {
        throw new Error('--palavras-json deve conter JSON válido.');
      }
    } else if (argument === '--root') options.root = readOption(argv, index++);
    else throw new Error(`Argumento desconhecido: ${argument}`);
  }
  if (selectors.length > 1) throw new Error('Informe apenas um seletor de segmento.');
  return options;
}

async function askForMissing(options, ask) {
  options.episode ??= await ask('Episódio (NNN): ');
  if (!options.selector) {
    const kind = await ask('Seletor (segmento, tempo ou trecho): ');
    const value = await ask(`Valor de ${kind}: `);
    if (kind === 'segmento') options.selector = { id: value };
    else if (kind === 'tempo') options.selector = { timestamp: Number(value) };
    else if (kind === 'trecho') options.selector = { excerpt: value };
    else throw new Error('Seletor deve ser segmento, tempo ou trecho.');
  }
  options.expectedText ??= await ask('Texto esperado: ');
  options.text ??= await ask('Texto corrigido: ');
  return options;
}

export async function runCli(argv, { input = process.stdin, output = process.stdout } = {}) {
  const options = parseArguments(argv);
  const readline = createInterface({ input, output });
  try {
    await askForMissing(options, (question) => readline.question(question));
    return await runCorrection({
      ...options,
      confirm: async () => (
        options.assumeYes || (await readline.question('Confirmar gravação? (sim/não): ')).trim().toLocaleLowerCase('pt-BR') === 'sim'
      ),
      output: (line) => output.write(`${line}\n`),
    });
  } finally {
    readline.close();
  }
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  await runCli(process.argv.slice(2));
}
