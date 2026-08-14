import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readAdaptivePlanCatalog } from '../../../scripts/plan-adaptation/adaptive-plan-catalog.mjs';

const repositoryRoot = path.resolve(__dirname, '../../..');
const governanceBaseline = 'd450f2521f93754a39bca5453ee27c8b63988534';

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

  it('keeps non-test governance growth within the compact implementation budget', () => {
    const numstat = execFileSync(
      'git',
      ['diff', '--numstat', governanceBaseline, '--', 'scripts', '.github', 'package.json'],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    const netLines =
      numstat
        .trim()
        .split('\n')
        .filter(Boolean)
        .reduce((total, line) => {
          const [added, deleted] = line.split('\t');
          return total + Number(added) - Number(deleted);
        }, 0) +
      execFileSync(
        'git',
        ['ls-files', '--others', '--exclude-standard', '--', 'scripts', '.github'],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
        },
      )
        .trim()
        .split('\n')
        .filter(Boolean)
        .reduce(
          (total, repositoryPath) =>
            total +
            readFileSync(path.join(repositoryRoot, repositoryPath), 'utf8').split('\n').length -
            1,
          0,
        );

    expect(netLines).toBeLessThanOrEqual(200);
  });
});
