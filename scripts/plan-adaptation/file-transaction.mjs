import { existsSync, lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function writeFileTransaction(input) {
  const replacements = input.replacements ?? [];
  const removals = input.removals ?? [];
  const targets = [...replacements.map((entry) => entry.path), ...removals];
  if (new Set(targets).size !== targets.length) {
    throw new Error('file transaction targets must be unique');
  }
  for (const target of targets) {
    validateTarget(target, removals.includes(target));
  }

  const staged = [];
  try {
    for (const entry of replacements) {
      const temporaryPath = `${entry.path}.plan-adaptation-${randomUUID()}.tmp`;
      writeFileSync(temporaryPath, entry.content, { flag: 'wx' });
      staged.push({ ...entry, temporaryPath });
    }
  } catch (error) {
    cleanupPaths(staged.map((entry) => entry.temporaryPath));
    throw error;
  }
  const backups = [];

  try {
    for (const target of targets) {
      if (!existsSync(target)) {
        continue;
      }
      const backupPath = `${target}.plan-adaptation-${randomUUID()}.backup`;
      renameSync(target, backupPath);
      backups.push({ target, backupPath });
    }
    for (const entry of staged) {
      renameSync(entry.temporaryPath, entry.path);
    }
  } catch (error) {
    rollbackTargets(targets, backups);
    cleanupPaths(staged.map((entry) => entry.temporaryPath));
    throw error;
  }

  cleanupPaths(backups.map((entry) => entry.backupPath));
}

function validateTarget(target, mustExist) {
  if (!existsSync(target)) {
    if (mustExist) {
      throw new Error(`transaction removal target does not exist: ${target}`);
    }
    return;
  }
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`transaction target must be a regular file: ${target}`);
  }
}

function rollbackTargets(targets, backups) {
  for (const target of [...targets].reverse()) {
    if (existsSync(target)) {
      rmSync(target, { force: true });
    }
    const backup = backups.find((entry) => entry.target === target);
    if (backup && existsSync(backup.backupPath)) {
      renameSync(backup.backupPath, target);
    }
  }
}

function cleanupPaths(paths) {
  for (const cleanupPath of paths) {
    rmSync(cleanupPath, { force: true });
  }
}
