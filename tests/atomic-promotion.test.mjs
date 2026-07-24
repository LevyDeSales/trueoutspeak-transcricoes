import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { promoteAtomically } from '../scripts/atomic-promotion.mjs';

async function createPromotionFixture() {
  const destinationDirectory = await mkdtemp(
    join(tmpdir(), 'trueoutspeak-promotion-'),
  );
  const stagingDirectory = join(destinationDirectory, '.stage');
  await mkdir(stagingDirectory);
  for (const name of ['alpha', 'beta']) {
    await writeFile(join(destinationDirectory, name), `old ${name}\n`);
    await writeFile(join(stagingDirectory, name), `new ${name}\n`);
  }
  return { destinationDirectory, stagingDirectory };
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

async function backupDirectories(root) {
  return (await readdir(root))
    .filter((name) => name.startsWith('.test-backup-'));
}

test('promotion failure restores every previous artifact', async () => {
  const fixture = await createPromotionFixture();

  await assert.rejects(promoteAtomically({
    ...fixture,
    names: ['alpha', 'beta'],
    backupPrefix: '.test-backup-',
    operations: {
      rename: async (source, destination) => {
        if (
          source.startsWith(fixture.stagingDirectory)
          && basename(source) === 'beta'
        ) {
          throw new Error('falha durante promoção');
        }
        await rename(source, destination);
      },
    },
  }), /falha durante promoção/i);

  assert.equal(
    await readFile(join(fixture.destinationDirectory, 'alpha'), 'utf8'),
    'old alpha\n',
  );
  assert.equal(
    await readFile(join(fixture.destinationDirectory, 'beta'), 'utf8'),
    'old beta\n',
  );
  assert.deepEqual(await backupDirectories(fixture.destinationDirectory), []);
});

test('failed restoration preserves and reports the recovery backup path', async () => {
  const fixture = await createPromotionFixture();
  let caught;

  try {
    await promoteAtomically({
      ...fixture,
      names: ['alpha', 'beta'],
      backupPrefix: '.test-backup-',
      operations: {
        rename: async (source, destination) => {
          if (
            source.startsWith(fixture.stagingDirectory)
            && basename(source) === 'beta'
          ) {
            throw new Error('falha durante promoção');
          }
          if (
            source.includes('.test-backup-')
            && basename(source) === 'beta'
          ) {
            throw new Error('falha durante restauração');
          }
          await rename(source, destination);
        },
      },
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, 'promotion must reject when restoration fails');
  assert.match(caught.message, /restauração.*backup preservado/i);
  assert.match(caught.message, /\.test-backup-/);
  assert.ok(await exists(caught.backupDirectory));
  assert.equal(
    await readFile(join(caught.backupDirectory, 'beta'), 'utf8'),
    'old beta\n',
  );
});

test('post-promotion cleanup failure is reported without undoing promoted artifacts', async () => {
  const fixture = await createPromotionFixture();

  const result = await promoteAtomically({
    ...fixture,
    names: ['alpha', 'beta'],
    backupPrefix: '.test-backup-',
    operations: {
      rm: async (path, options) => {
        if (basename(path).startsWith('.test-backup-')) {
          throw new Error('falha durante cleanup');
        }
        await rm(path, options);
      },
    },
  });

  assert.equal(
    await readFile(join(fixture.destinationDirectory, 'alpha'), 'utf8'),
    'new alpha\n',
  );
  assert.equal(
    await readFile(join(fixture.destinationDirectory, 'beta'), 'utf8'),
    'new beta\n',
  );
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /cleanup.*backup/i);
  assert.match(result.warnings[0], /\.test-backup-/);
});
