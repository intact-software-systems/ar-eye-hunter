import { existsSync, lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const fileOperations = {
  exists: existsSync,
  inspect: lstatSync,
  write: writeFileSync,
  rename: renameSync,
  remove: rmSync,
};

export function writeFileTransaction(input, operations = fileOperations) {
  const replacements = input.replacements ?? [];
  const removals = input.removals ?? [];
  const targets = [...replacements.map((entry) => entry.path), ...removals];
  if (new Set(targets).size !== targets.length) {
    throw new Error('file transaction targets must be unique');
  }
  for (const target of targets) {
    validateTarget(target, removals.includes(target), operations);
  }

  const staged = [];
  try {
    for (const entry of replacements) {
      const temporaryPath = `${entry.path}.plan-adaptation-${randomUUID()}.tmp`;
      operations.write(temporaryPath, entry.content, { flag: 'wx' });
      staged.push({ ...entry, temporaryPath });
    }
  } catch (error) {
    cleanupPaths(
      staged.map((entry) => entry.temporaryPath),
      operations,
    );
    throw error;
  }
  const backups = [];
  const installed = [];

  try {
    for (const target of targets) {
      if (!operations.exists(target)) {
        continue;
      }
      const backupPath = `${target}.plan-adaptation-${randomUUID()}.backup`;
      operations.rename(target, backupPath);
      backups.push({ target, backupPath });
    }
    for (const entry of staged) {
      operations.rename(entry.temporaryPath, entry.path);
      installed.push(entry.path);
    }
  } catch (error) {
    rollbackTargets(installed, backups, operations);
    cleanupPaths(
      staged.map((entry) => entry.temporaryPath),
      operations,
    );
    throw error;
  }

  cleanupPaths(
    backups.map((entry) => entry.backupPath),
    operations,
    true,
  );
}

function validateTarget(target, mustExist, operations) {
  if (!operations.exists(target)) {
    if (mustExist) {
      throw new Error(`transaction removal target does not exist: ${target}`);
    }
    return;
  }
  const stat = operations.inspect(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`transaction target must be a regular file: ${target}`);
  }
}

function rollbackTargets(installed, backups, operations) {
  for (const target of [...installed].reverse()) {
    if (operations.exists(target)) {
      operations.remove(target, { force: true });
    }
  }
  for (const backup of [...backups].reverse()) {
    if (operations.exists(backup.backupPath)) {
      operations.rename(backup.backupPath, backup.target);
    }
  }
}

function cleanupPaths(paths, operations, bestEffort = false) {
  for (const cleanupPath of paths) {
    try {
      operations.remove(cleanupPath, { force: true });
    } catch (error) {
      if (!bestEffort) {
        throw error;
      }
    }
  }
}
