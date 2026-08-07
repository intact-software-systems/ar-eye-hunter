import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { readBoundaryOwnerContentByName } from './auth-server-lineage-boundary-analysis.ts';

export const persistenceBase = 'a90042398448776b0972aaaaa0f5cca762163fde';
export const persistenceManifestPath =
  'plans/repo-style-lineages/rallar-auth-server-pr-b-persistence.json';
export const persistenceSourceRoot = 'packages/shared-server/rallar-system/repositories';
export const persistenceTargetRoot = 'packages/shared-server/rallar-system/auth/persistence';

export interface PersistenceLineage {
  mergeBase: string;
  source: { path: string; blob: string };
  targets: string[];
}

export const persistenceLineages = [
  persistenceLineage(
    'AuthSessionRepository.ts',
    '6721085e4a0ffac584da9e159f39ce3e70b80be4',
    'auth-session-repository.ts',
  ),
  persistenceLineage(
    'AuthUserRepository.ts',
    '960ce5a419477719ca8532c63b64ba599a8ae582',
    'auth-user-repository.ts',
  ),
  persistenceLineage(
    'auth-legacy-compatibility.ts',
    '7ef04186cdfeda6aec8c9420936db78428e6bfef',
    'auth-legacy-compatibility.ts',
  ),
  persistenceLineage(
    'auth-persistence-contracts.ts',
    '26a16af1ee09a0f9d101aec6e0fac1b18cb3f3ab',
    'auth-persistence-contracts.ts',
  ),
  persistenceLineage(
    'auth-session-persistence.ts',
    '12aa8dbbe55114411f9bf71512b17e177e2f3258',
    'auth-session-persistence.ts',
  ),
  persistenceLineage(
    'auth-session-types.ts',
    'd484d00732deaa254abe350ba196ca84a13b1d8a',
    'auth-session-types.ts',
  ),
  persistenceLineage(
    'auth-ticket-persistence.ts',
    '32db40789e181712b1665c84967ce3123b82219a',
    'auth-ticket-persistence.ts',
  ),
] as const;

// Temporary structural supplement owned by the auth child. PR C removes it after
// the PR B resulting-main workflow and later ledger preserve equivalent evidence.
export function validatePersistenceLineages(
  lineages: readonly PersistenceLineage[],
  targetOverrides = new Map<string, string>(),
): void {
  for (const lineage of lineages) {
    if (lineage.mergeBase !== persistenceBase) throw new Error('persistence base');
    const source = readBase(lineage.source.path);
    if (gitBlob(lineage.source.path) !== lineage.source.blob) {
      throw new Error('persistence source blob');
    }
    if (lineage.targets.length !== 1 || !existsSync(absolute(lineage.targets[0]))) {
      throw new Error('persistence target');
    }
    const target = targetOverrides.get(lineage.targets[0]) ?? read(lineage.targets[0]);
    validatePersistenceTargetDerivation(source, target);
  }
}

function validatePersistenceTargetDerivation(source: string, target: string): void {
  const errorPrefix = 'persistence target derivation';
  const sourceOwners = readBoundaryOwnerContentByName(source, errorPrefix);
  const targetOwners = readBoundaryOwnerContentByName(target, errorPrefix);

  for (const [name, targetOwnerContent] of targetOwners) {
    if (sourceOwners.get(name) !== targetOwnerContent) {
      throw new Error(`persistence target derivation: ${name}`);
    }
  }
}

function readBase(filePath: string): string {
  return execFileSync('git', ['show', `${persistenceBase}:${filePath}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function gitBlob(filePath: string): string {
  return execFileSync('git', ['rev-parse', `${persistenceBase}:${filePath}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
}

function read(filePath: string): string {
  return readFileSync(absolute(filePath), 'utf8');
}

function absolute(filePath: string): string {
  return path.join(process.cwd(), filePath);
}

function persistenceLineage(sourceName: string, blob: string, targetName: string) {
  return {
    mergeBase: persistenceBase,
    source: { path: `${persistenceSourceRoot}/${sourceName}`, blob },
    targets: [`${persistenceTargetRoot}/${targetName}`],
  };
}
