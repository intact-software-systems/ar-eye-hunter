import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readAdaptivePlanCatalog } from '../../../scripts/plan-adaptation/adaptive-plan-catalog.mjs';

const repositoryRoot = path.resolve(__dirname, '../../..');

describe('repository adaptive-plan governance', () => {
  it('keeps the administrator policy and static plan navigation coherent', () => {
    const catalog = readAdaptivePlanCatalog(repositoryRoot);
    const navigation = readFileSync(path.join(repositoryRoot, 'plans/README.md'), 'utf8');

    expect(catalog.policy).toEqual({
      schemaVersion: 'adaptive-plan-policy-v1',
      maxActivePlans: 8,
    });
    expect(navigation).toContain('npm run plan:adapt -- overview');
    expect(navigation).not.toContain('plan-adaptation-v1');
    expect(navigation).not.toContain('Active adaptive plans');
  });
});
