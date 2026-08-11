import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const githubAutomationRoots = ['.github/actions', '.github/workflows'] as const;
const requiredActionReferences = {
  cache: 'actions/cache@v6',
  checkout: 'actions/checkout@v7',
  'setup-node': 'actions/setup-node@v7',
  'upload-artifact': 'actions/upload-artifact@v7',
} as const;

type GovernedActionName = keyof typeof requiredActionReferences;

async function findYamlFiles(relativeDirectory: string): Promise<string[]> {
  const entries = await readdir(path.join(repoRoot, relativeDirectory), {
    withFileTypes: true,
  });
  const files: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await findYamlFiles(relativePath)));
      continue;
    }

    if (/\.ya?ml$/u.test(entry.name)) {
      files.push(relativePath);
    }
  }

  return files;
}

function sourceLine(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

describe('GitHub Actions runtime governance', () => {
  it('blocks changed structure-coupling candidates without individual classifications', async () => {
    const releaseGate = await readFile(
      path.join(repoRoot, '.github/workflows/release-gate.yml'),
      'utf8',
    );

    expect(releaseGate).toContain(
      'npm run check:test-structure-coupling -- "--changed" "${{ inputs.changed_repo_style_base }}" HEAD',
    );
  });

  it('uses the Node 24 action releases throughout executable automation', async () => {
    const yamlFiles = (await Promise.all(githubAutomationRoots.map(findYamlFiles))).flat();
    const observedActions = new Set<GovernedActionName>();
    const violations: string[] = [];
    const actionReference =
      /uses:\s*actions\/(cache|checkout|setup-node|upload-artifact)@([^\s#'"]+)/gu;

    for (const relativePath of yamlFiles) {
      const source = await readFile(path.join(repoRoot, relativePath), 'utf8');

      for (const match of source.matchAll(actionReference)) {
        const actionName = match[1] as GovernedActionName;
        const actualReference = `actions/${actionName}@${match[2]}`;
        const expectedReference = requiredActionReferences[actionName];

        observedActions.add(actionName);

        if (actualReference !== expectedReference) {
          violations.push(
            `${relativePath}:${sourceLine(source, match.index)} uses ${actualReference}; expected ${expectedReference}`,
          );
        }
      }
    }

    expect([...observedActions].sort()).toEqual(Object.keys(requiredActionReferences).sort());
    expect(violations).toEqual([]);
  });
});
