import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const commandReferencePath = '.agents/skills/rallar-testing/references/test-commands.md';
const architecturePath = 'packages/shared-server/architecture.md';
const convergenceGuidePath = 'docs/rallar-convergent-state-and-rtc-topology.md';

describe('group-state traceability active paths', () => {
  it('keeps active documentation commands on the renamed traceability suites', () => {
    const commandReference = readFileSync(commandReferencePath, 'utf8');
    const architecture = readFileSync(architecturePath, 'utf8');
    const convergenceGuide = readFileSync(convergenceGuidePath, 'utf8');
    const activePaths = [
      'packages/tests/shared-server/group-state/inbox/app-group-inbox-registration-lifecycle.test.ts',
      'packages/tests/shared-server/group-state/inbox/group-state-inbox-transaction-result.test.ts',
      'packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts',
    ];

    for (const activePath of activePaths) {
      expect(existsSync(activePath), activePath).toBe(true);
    }
    expect(commandReference).toContain(activePaths[0]);
    expect(commandReference).toContain(activePaths[1]);
    expect(architecture).toContain(activePaths[2]);
    expect(convergenceGuide).toContain(activePaths[2]);
    expect(commandReference).not.toContain('packages/tests/shared-server/app-group-inbox-');
    expect(architecture).not.toContain('read-compute-write-contract.test.ts');
    expect(convergenceGuide).not.toContain('read-compute-write-contract.test.ts');
  });
});
