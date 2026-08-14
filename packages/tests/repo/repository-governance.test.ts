import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(__dirname, '../../..');

describe('repository pull request governance', () => {
  it('keeps ordinary pull request intent semantic and human-readable', () => {
    const template = readRepo('.github/PULL_REQUEST_TEMPLATE.md');

    expect(template.match(/^## .+$/gmu)?.map((heading) => heading.replace('## ', ''))).toEqual([
      'Goal',
      'Changes',
      'Acceptance',
      'Validation',
      'Risk and rollback',
      'Follow-up',
    ]);
    expect(template).toContain('None');
    expect(template).not.toMatch(/```|sha|digest|reviewer|plan-adaptation|changed paths/iu);
  });

  it('keeps historical plans inert rather than a shared active catalog', () => {
    const navigation = readRepo('plans/README.md');

    expect(navigation).toContain('inert historical reference material');
    expect(navigation).not.toMatch(/plan:adapt|active plan|capacity|mutable ownership|overview/iu);
  });

  it('records no ordinary completion ledger outside the pull request', () => {
    const agents = normalize(readRepo('AGENTS.md'));

    expect(agents).toContain('Ordinary pull request completion creates no tracked governance file');
    expect(agents).toContain('GitHub reports the pull request as merged');
  });
});

function readRepo(repositoryPath: string): string {
  return readFileSync(path.join(repositoryRoot, repositoryPath), 'utf8');
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}
