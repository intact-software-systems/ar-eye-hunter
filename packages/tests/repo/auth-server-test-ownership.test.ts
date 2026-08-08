import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

const repoRoot = process.cwd();
const authTestRoot = 'packages/tests/shared-server/auth';
const activeAuthTestOwners = [
  'auth-command-and-result-codec-contracts.test.ts',
  'auth-command-and-result-codec-regressions.test.ts',
  'auth-command-and-result-codecs.test.ts',
  'auth-command-routing-contract.test.ts',
  'auth-credential-and-login-contracts.test.ts',
  'auth-credential-login.test.ts',
  'auth-inbox-phase-order.test.ts',
  'auth-inbox-registration-and-routing.test.ts',
  'auth-legacy-cutoff.test.ts',
  'auth-legacy-read-order.test.ts',
  'auth-legacy-replay.test.ts',
  'auth-logout-outbox.test.ts',
  'auth-mutation-agent-compute-order.test.ts',
  'auth-mutation-compute-evaluation-order.test.ts',
  'auth-mutation-compute.test.ts',
  'auth-mutation-facts.test.ts',
  'auth-mutation-router-evaluation-order.test.ts',
  'auth-mutation-service.test.ts',
  'auth-mutation-validation-early-exit.test.ts',
  'auth-mutation-validation.test.ts',
  'auth-persistence-security.test.ts',
  'auth-public-command-routing.test.ts',
  'auth-public-result.test.ts',
  'auth-request-proof-digests.test.ts',
  'auth-request-proof.test.ts',
  'auth-session-persistence-security.test.ts',
  'auth-ticket-conflict.test.ts',
  'auth-transaction-boundary.test.ts',
] as const;
const activeAuthSupportOwners = [
  'auth-app-inbox-test-runtime.ts',
  'auth-test-fixtures.ts',
] as const;
const removedPredecessors = [
  'packages/tests/shared-server/app-auth-conflict-inbox.test.ts',
  'packages/tests/shared-server/app-auth-inbox-service.test.ts',
  'packages/tests/shared-server/app-auth-inbox-test-harness.ts',
  'packages/tests/shared-server/app-auth-legacy-cutoff.test.ts',
  'packages/tests/shared-server/app-auth-legacy-replay-inbox.test.ts',
  'packages/tests/shared-server/app-auth-persistence-inbox.test.ts',
  'packages/tests/shared-server/app-auth-public-routing-inbox.test.ts',
  'packages/tests/shared-server/app-auth-transaction-inbox.test.ts',
  'packages/tests/shared-server/auth-fixture.ts',
  'packages/tests/shared-server/auth-login-service.test.ts',
  'packages/tests/shared-server/request-auth-service.test.ts',
] as const;
const authRepositorySuites = [
  'packages/tests/repo/auth-server-lineage-provenance.test.ts',
  'packages/tests/repo/auth-server-shell-lineage-provenance.test.ts',
  'packages/tests/repo/auth-server-compatibility-governance.test.ts',
  'packages/tests/repo/auth-server-compatibility-runtime-identity.test.ts',
  'packages/tests/repo/auth-server-navigation-map-integrity.test.ts',
  'packages/tests/repo/auth-server-ownership.test.ts',
  'packages/tests/repo/auth-server-source-ratchet.test.ts',
  'packages/tests/repo/auth-server-test-provenance.test.ts',
  'packages/tests/repo/auth-server-touched-typescript-diagnostics.test.ts',
  'packages/tests/repo/auth-server-test-ownership.test.ts',
] as const;

// Retain this exact inventory through PR C. The later ledger may remove it only
// after the PR C resulting-main workflow publishes equivalent ownership evidence.
it('keeps the complete active semantic test inventory present', () => {
  const actualOwners = readdirSync(absolute(authTestRoot))
    .filter((name) => name.endsWith('.test.ts'))
    .toSorted();

  expect(actualOwners).toEqual([...activeAuthTestOwners].toSorted());
  expect(
    activeAuthTestOwners.every((owner) => existsSync(absolute(`${authTestRoot}/${owner}`))),
  ).toBe(true);
});

it('keeps behavior-owned auth support files and rejects every predecessor path', () => {
  const supportOwners = readdirSync(absolute(authTestRoot))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .toSorted();

  expect(supportOwners).toEqual([...activeAuthSupportOwners].toSorted());
  expect(removedPredecessors.filter((filePath) => existsSync(absolute(filePath)))).toEqual([]);
});

it('keeps all ten auth evidence suites registered in repository governance', () => {
  const packageJson = JSON.parse(readFileSync(absolute('package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const governanceCommand = packageJson.scripts['test:repo-governance'];

  for (const suite of authRepositorySuites) {
    expect(
      governanceCommand.split(' ').filter((token) => token === suite),
      suite,
    ).toEqual([suite]);
  }
});

function absolute(filePath: string): string {
  return path.join(repoRoot, filePath);
}
