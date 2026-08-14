import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readAdaptivePlanCatalog,
  readAdaptivePlanPolicy,
  toAdaptivePlanOverview,
} from '../../../../scripts/plan-adaptation/adaptive-plan-catalog.mjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('adaptive plan catalog', () => {
  it('reads the exact tracked policy with the repository default of eight', () => {
    const root = createCatalog();

    expect(readAdaptivePlanPolicy(root)).toEqual({
      schemaVersion: 'adaptive-plan-policy-v1',
      maxActivePlans: 8,
    });

    writePolicy(root, { schemaVersion: 'adaptive-plan-policy-v1', maxActivePlans: 8, extra: true });
    expect(() => readAdaptivePlanPolicy(root)).toThrow('policy must contain exactly');
    writePolicy(root, { schemaVersion: 'adaptive-plan-policy-v1', maxActivePlans: 0 });
    expect(() => readAdaptivePlanPolicy(root)).toThrow('positive safe integer');
  });

  it('rejects a symlinked policy before reading outside bytes', () => {
    const root = createCatalog();
    const outside = `${root}-outside-policy.json`;
    roots.push(outside);
    writeFileSync(
      outside,
      JSON.stringify({ schemaVersion: 'adaptive-plan-policy-v1', maxActivePlans: 8 }),
    );
    rmSync(path.join(root, 'plans/policy.json'));
    symlinkSync(outside, path.join(root, 'plans/policy.json'));

    expect(() => readAdaptivePlanPolicy(root)).toThrow('policy must be a regular file');
  });

  it('accepts zero through eight active plans and reports every plan above capacity', () => {
    const root = createCatalog();
    for (let index = 1; index <= 8; index += 1) {
      writePlan(root, `plan-${index}`, 'active', `packages/owner-${index}`);
    }
    expect(readAdaptivePlanCatalog(root).issues).toEqual([]);

    writePlan(root, 'plan-9', 'active', 'packages/owner-9');
    const overCapacity = readAdaptivePlanCatalog(root);
    expect(overCapacity.capacity).toEqual({
      active: 9,
      postponed: 0,
      maximum: 8,
      remaining: 0,
      excess: 1,
    });
    expect(overCapacity.issues.join('\n')).toContain(
      'active plan capacity 9/8 exceeded: plan-1, plan-2, plan-3, plan-4, plan-5, plan-6, plan-7, plan-8, plan-9',
    );

    writePolicy(root, { schemaVersion: 'adaptive-plan-policy-v1', maxActivePlans: 9 });
    expect(readAdaptivePlanCatalog(root).issues).toEqual([]);
    writePolicy(root, { schemaVersion: 'adaptive-plan-policy-v1', maxActivePlans: 7 });
    expect(readAdaptivePlanCatalog(root).capacity.excess).toBe(2);
  });

  it('reserves mutable roots and exact paths only for active plans', () => {
    const root = createCatalog();
    writePlan(root, 'first', 'active', 'packages/shared');
    writePlan(root, 'nested', 'active', 'packages/shared/nested');
    const overlap = readAdaptivePlanCatalog(root);

    expect(overlap.ownershipConflicts).toEqual([
      expect.objectContaining({ leftPlanId: 'first', rightPlanId: 'nested' }),
    ]);
    expect(overlap.issues[0]).toContain('mutable ownership overlap');

    writePlan(root, 'nested', 'postponed', 'packages/shared/nested');
    const postponed = readAdaptivePlanCatalog(root);
    expect(postponed.issues).toEqual([]);
    expect(postponed.activePlans.map((plan) => plan.record.planId)).toEqual(['first']);
    expect(postponed.postponedPlans.map((plan) => plan.record.planId)).toEqual(['nested']);
  });

  it('detects an exact contract collision between otherwise disjoint roots', () => {
    const root = createCatalog();
    writePlan(root, 'first', 'active', 'packages/first', '.github/workflows/shared.yml');
    writePlan(root, 'second', 'active', 'packages/second', '.github/workflows/shared.yml');

    expect(readAdaptivePlanCatalog(root).issues).toEqual([
      expect.stringContaining('.github/workflows/shared.yml'),
    ]);
  });

  it('renders a deterministic ignored overview without treating it as repository state', () => {
    const root = createCatalog();
    writePlan(root, 'zeta', 'postponed', 'packages/zeta');
    writePlan(root, 'alpha', 'active', 'packages/alpha');

    expect(toAdaptivePlanOverview(readAdaptivePlanCatalog(root))).toBe(
      '# Adaptive plan overview\n\n' +
        'Capacity: 1/8 active, 1 postponed, 7 available.\n\n' +
        '| Plan | Status | Capability owners | Checkpoint | Next slices |\n' +
        '| --- | --- | --- | --- | --- |\n' +
        '| alpha | active | alpha owner | continue | alpha-slice |\n' +
        '| zeta | postponed | zeta owner | continue | zeta-slice |\n',
    );
  });
});

function createCatalog() {
  const root = mkdtempSync(path.join(tmpdir(), 'adaptive-plan-catalog-'));
  roots.push(root);
  mkdirSync(path.join(root, 'plans'));
  writePolicy(root, { schemaVersion: 'adaptive-plan-policy-v1', maxActivePlans: 8 });
  return root;
}

function writePolicy(root: string, policy: object) {
  writeFileSync(path.join(root, 'plans/policy.json'), `${JSON.stringify(policy)}\n`);
}

function writePlan(
  root: string,
  planId: string,
  status: 'active' | 'postponed',
  capabilityRoot: string,
  contractPath?: string,
) {
  const record = {
    planId,
    status,
    capabilities: [
      {
        owner: `${planId} owner`,
        root: capabilityRoot,
        entry: `${capabilityRoot}.mjs`,
        testRoot: `packages/tests/${planId}`,
        navigationMap: `${capabilityRoot}/README.md`,
        factContracts: [],
        contractPaths: contractPath === undefined ? [] : [contractPath],
      },
    ],
    checkpoint: { decision: 'continue', nextSlices: [`${planId}-slice`] },
  };
  writeFileSync(
    path.join(root, `plans/${planId}.md`),
    `# ${planId}\n\n\`\`\`plan-adaptation-v1\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`,
  );
}
