import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const authTestRoot = 'packages/tests/shared-server/auth';
const activeAuthTestOwners = [
  'auth-command-and-result-codec-regressions.test.ts',
  'auth-command-and-result-codecs.test.ts',
  'auth-credential-login.test.ts',
  'auth-inbox-registration-and-routing.test.ts',
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
  'auth-request-proof.test.ts',
] as const;
const authRepositorySuites = [
  'packages/tests/repo/auth-server-lineage-provenance.test.ts',
  'packages/tests/repo/auth-server-shell-lineage-provenance.test.ts',
  'packages/tests/repo/auth-server-navigation-map-integrity.test.ts',
  'packages/tests/repo/auth-server-ownership.test.ts',
  'packages/tests/repo/auth-server-test-ownership.test.ts',
] as const;

describe('auth server test ownership', () => {
  it('keeps the complete active semantic test inventory present', () => {
    const actualOwners = readdirSync(absolute(authTestRoot))
      .filter((name) => name.endsWith('.test.ts'))
      .toSorted();

    expect(actualOwners).toEqual([...activeAuthTestOwners].toSorted());
    expect(
      activeAuthTestOwners.every((owner) => existsSync(absolute(`${authTestRoot}/${owner}`))),
    ).toBe(true);
  });

  it('keeps all five auth evidence suites registered in repository governance', () => {
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
});

function absolute(filePath: string): string {
  return path.join(repoRoot, filePath);
}
