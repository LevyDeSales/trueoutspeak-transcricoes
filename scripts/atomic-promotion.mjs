import {
  lstat,
  mkdir,
  rename,
  rm,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const defaultOperations = {
  lstat,
  mkdir,
  rename,
  rm,
};

function withDefaultOperations(operations = {}) {
  return { ...defaultOperations, ...operations };
}

async function exists(path, operations) {
  try {
    await operations.lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function cleanupPathBestEffort(
  path,
  {
    operations: operationOverrides,
    description = 'staging',
  } = {},
) {
  const operations = withDefaultOperations(operationOverrides);
  try {
    await operations.rm(path, { recursive: true, force: true });
    return [];
  } catch (error) {
    return [
      `Cleanup pendente para ${description} ${path}: ${error.message}`,
    ];
  }
}

export async function promoteAtomically({
  destinationDirectory,
  stagingDirectory,
  names,
  backupPrefix,
  operations: operationOverrides,
}) {
  const operations = withDefaultOperations(operationOverrides);
  const backupDirectory = join(
    destinationDirectory,
    `${backupPrefix}${randomUUID()}`,
  );
  const backedUp = [];
  const promoted = [];
  await operations.mkdir(backupDirectory);

  try {
    for (const name of names) {
      const target = join(destinationDirectory, name);
      if (await exists(target, operations)) {
        await operations.rename(target, join(backupDirectory, name));
        backedUp.push(name);
      }
    }

    for (const name of names) {
      await operations.rename(
        join(stagingDirectory, name),
        join(destinationDirectory, name),
      );
      promoted.push(name);
    }
  } catch (transactionError) {
    const restorationErrors = [];
    for (const name of promoted.reverse()) {
      try {
        await operations.rm(join(destinationDirectory, name), {
          recursive: true,
          force: true,
        });
      } catch (error) {
        restorationErrors.push(error);
      }
    }
    for (const name of backedUp.reverse()) {
      try {
        await operations.rename(
          join(backupDirectory, name),
          join(destinationDirectory, name),
        );
      } catch (error) {
        restorationErrors.push(error);
      }
    }

    if (restorationErrors.length > 0) {
      const restorationError = new Error(
        [
          'Falha durante restauração;',
          `backup preservado em ${backupDirectory}.`,
          `Falha transacional: ${transactionError.message}.`,
          `Falha de restauração: ${
            restorationErrors.map(({ message }) => message).join('; ')
          }`,
        ].join(' '),
        { cause: transactionError },
      );
      restorationError.backupDirectory = backupDirectory;
      restorationError.restorationErrors = restorationErrors;
      throw restorationError;
    }

    const cleanupWarnings = await cleanupPathBestEffort(backupDirectory, {
      operations,
      description: 'backup de rollback',
    });
    if (cleanupWarnings.length > 0) {
      transactionError.message = `${
        transactionError.message
      } ${cleanupWarnings.join(' ')}`;
      transactionError.backupDirectory = backupDirectory;
    }
    throw transactionError;
  }

  const warnings = await cleanupPathBestEffort(backupDirectory, {
    operations,
    description: 'backup pós-promoção',
  });
  return { warnings };
}
