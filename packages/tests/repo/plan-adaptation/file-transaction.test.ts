import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeFileTransaction } from '../../../../scripts/plan-adaptation/file-transaction.mjs';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('file transaction rollback', () => {
  it('restores backed-up targets without deleting untouched targets when a backup fails', () => {
    const fixture = createFixture();
    const operations = createFailureOperations({ failRenameAt: 2 });

    expect(() => runReplacementTransaction(fixture, operations)).toThrow('injected rename failure');

    expect(readFixtureState(fixture)).toEqual({ first: 'old first', second: 'old second' });
    expect(readFileSync(fixture.removed, 'utf8')).toBe('old removed');
    expect(transactionDebris(fixture.root)).toEqual([]);
  });

  it('restores every original when a replacement commit fails after an earlier commit', () => {
    const fixture = createFixture();
    const operations = createFailureOperations({ failRenameAt: 5 });

    expect(() => runReplacementTransaction(fixture, operations)).toThrow('injected rename failure');

    expect(readFixtureState(fixture)).toEqual({ first: 'old first', second: 'old second' });
    expect(readFileSync(fixture.removed, 'utf8')).toBe('old removed');
    expect(transactionDebris(fixture.root)).toEqual([]);
  });

  it('reports committed success when only best-effort backup cleanup fails', () => {
    const fixture = createFixture();
    const operations = createFailureOperations({ failBackupCleanup: true });

    expect(() => runReplacementTransaction(fixture, operations)).not.toThrow();

    expect(readFixtureState(fixture)).toEqual({ first: 'new first', second: 'new second' });
    expect(existsSync(fixture.removed)).toBe(false);
    expect(operations.backupCleanupAttempts()).toBeGreaterThan(0);
  });
});

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'plan-adaptation-transaction-'));
  fixtureRoots.push(root);
  const first = path.join(root, 'first.md');
  const second = path.join(root, 'second.md');
  const removed = path.join(root, 'removed.md');
  writeFileSync(first, 'old first');
  writeFileSync(second, 'old second');
  writeFileSync(removed, 'old removed');
  return { root, first, second, removed };
}

function runReplacementTransaction(
  fixture: ReturnType<typeof createFixture>,
  operations: ReturnType<typeof createFailureOperations>,
) {
  writeFileTransaction(
    {
      replacements: [
        { path: fixture.first, content: 'new first' },
        { path: fixture.second, content: 'new second' },
      ],
      removals: [fixture.removed],
    },
    operations,
  );
}

function readFixtureState(fixture: ReturnType<typeof createFixture>) {
  return {
    first: readFileSync(fixture.first, 'utf8'),
    second: readFileSync(fixture.second, 'utf8'),
  };
}

function transactionDebris(root: string) {
  return readdirSync(root).filter((name) => name.includes('.plan-adaptation-'));
}

function createFailureOperations(input: { failRenameAt?: number; failBackupCleanup?: boolean }) {
  let renameCount = 0;
  let backupCleanupAttempts = 0;
  return {
    exists: existsSync,
    inspect: lstatSync,
    write: writeFileSync,
    rename(source: string, destination: string) {
      renameCount += 1;
      if (renameCount === input.failRenameAt) {
        throw new Error('injected rename failure');
      }
      renameSync(source, destination);
    },
    remove(target: string, options: { force: boolean }) {
      if (target.includes('.backup')) {
        backupCleanupAttempts += 1;
        if (input.failBackupCleanup) {
          throw new Error('injected backup cleanup failure');
        }
      }
      rmSync(target, options);
    },
    backupCleanupAttempts: () => backupCleanupAttempts,
  };
}
