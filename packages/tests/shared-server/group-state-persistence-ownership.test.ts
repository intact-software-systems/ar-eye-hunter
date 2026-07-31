import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  createTransactionBoundGroupStateRepository,
  GroupStateRepository,
} from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';

describe('GroupStateRepository persistence ownership', () => {
  it('constructs the public facade for transaction-bound persistence', () => {
    const transaction = (() => undefined) as unknown as Parameters<
      typeof createTransactionBoundGroupStateRepository
    >[0];
    expect(createTransactionBoundGroupStateRepository(transaction)).toBeInstanceOf(
      GroupStateRepository,
    );
  });

  it('keeps the approved persistence owners behind one public compatibility hop', () => {
    const root = 'packages/shared-server/rallar-system/group-state/persistence';
    for (const [file, symbol] of [
      ['group-state-repository.ts', 'GroupStateRepository'],
      ['group-state-repository-reads.ts', 'GroupStateRepositoryReads'],
      ['group-aggregate-repository.ts', 'GroupAggregateRepository'],
      ['group-membership-repository.ts', 'GroupMembershipRepository'],
      ['group-presence-repository.ts', 'GroupPresenceRepository'],
      ['group-state-snapshot-repository.ts', 'GroupStateSnapshotRepository'],
    ]) {
      expect(readFileSync(`${root}/${file}`, 'utf8')).toContain(`class ${symbol}`);
    }
    const oldRoot = 'packages/shared-server/rallar-system/repositories';
    const compatibility = readFileSync(`${oldRoot}/GroupStateRepository.ts`, 'utf8');
    expect(compatibility).not.toContain('export *');
    expect(compatibility).toContain('../group-state/persistence/group-state-repository.ts');
    for (const oldFile of [
      'group-state-authority-batch-read.ts',
      'group-state-mutation-exact-read.ts',
      'group-state-snapshot-assembly.ts',
    ]) {
      expect(existsSync(`${oldRoot}/${oldFile}`), oldFile).toBe(false);
    }
  });
});
