import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const base = '8b1ebf542d12c05a5ac226d3d07e543a171a2626';
const movedSources = [
  'packages/tests/shared-server/group-topology-config-service.test.ts',
  'packages/tests/shared-server/topology-app-inbox-contract.test.ts',
  'packages/tests/shared-server/topology-app-inbox-authority.test.ts',
  'packages/tests/shared-server/topology-app-inbox-handler.test.ts',
  'packages/tests/shared-server/topology-app-inbox-ownership.test.ts',
] as const;
const targetTests = [
  'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts',
  'packages/tests/shared-server/topology/inbox/topology-app-inbox-authority.test.ts',
  'packages/tests/shared-server/topology/inbox/topology-app-inbox-handler.test.ts',
  'packages/tests/shared-server/topology/inbox/topology-app-inbox-ownership.test.ts',
  'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts',
  'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts',
  'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-idempotency.test.ts',
  'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts',
  'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-result.test.ts',
] as const;

describe('group topology server PR-A test ownership', () => {
  it('moves every predecessor suite to behavior-named mirrored owners', () => {
    for (const source of movedSources) expect(existsSync(absolute(source)), source).toBe(false);
    for (const target of targetTests) expect(existsSync(absolute(target)), target).toBe(true);
  });

  it('preserves at least every source semantic case and assertion site', () => {
    const source = movedSources.map(readBase).join('\n');
    const target = targetTests.map(read).join('\n');

    expect(testCallsites(target)).toBeGreaterThanOrEqual(testCallsites(source));
    expect(expectCallsites(target)).toBeGreaterThanOrEqual(expectCallsites(source));
  });

  it('keeps every moved test and support owner within 400 physical lines', () => {
    for (const target of [
      ...targetTests,
      'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts',
    ]) {
      expect(read(target).split('\n').length, target).toBeLessThanOrEqual(401);
    }
  });
});

function testCallsites(source: string): number {
  return [...source.matchAll(/\b(?:it|test)(?:\.each)?\s*\(/gu)].length;
}

function expectCallsites(source: string): number {
  return [...source.matchAll(/\bexpect(?:TypeOf)?\s*\(/gu)].length;
}

function readBase(relativePath: string): string {
  return execFileSync('git', ['show', `${base}:${relativePath}`], { encoding: 'utf8' });
}

function read(relativePath: string): string {
  return readFileSync(absolute(relativePath), 'utf8');
}

function absolute(relativePath: string): string {
  return path.join(repoRoot, relativePath);
}
