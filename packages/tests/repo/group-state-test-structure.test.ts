import { parse } from '@babel/parser';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const groupStateTestRoot = path.join(repoRoot, 'packages/tests/shared-server/group-state');
const predecessorPath = path.join(
  repoRoot,
  'packages/tests/shared-server/group-state-concurrency.test.ts',
);

const expectedTargetTree = [
  'group-state-concurrency-test-fixtures.ts',
  'group-state-concurrency-test-runtime.ts',
  'group-state-service-idempotency-command.test.ts',
  'group-state-service-idempotency-concurrency.test.ts',
  'group-state-service-idempotency.test.ts',
  'group-state-test-mutation-executor.ts',
  'group-state-test-runtime.ts',
  'inbox/group-state-inbox-authority.test.ts',
  'inbox/group-state-inbox-construction.test.ts',
  'inbox/group-state-inbox-operation-matrix.test.ts',
  'inbox/group-state-inbox-retry-convergence.test.ts',
  'inbox/group-state-inbox-retry.test.ts',
  'inbox/group-state-inbox-test-runtime.ts',
  'mutation/group-aggregate-mutation-concurrency.test.ts',
  'mutation/group-aggregate-mutation.test.ts',
  'mutation/group-membership-mutation.test.ts',
  'mutation/group-mutation-command-validation.test.ts',
  'mutation/group-mutation-request-validation.test.ts',
  'mutation/group-mutation-result-persistence.test.ts',
  'mutation/group-mutation-result.test.ts',
  'mutation/group-mutation-test-runtime.ts',
  'mutation/group-presence-mutation.test.ts',
  'mutation/read-group-mutation-retry.test.ts',
  'mutation/read-group-mutation.test.ts',
  'mutation/write-group-state-mutation-atomicity.test.ts',
  'mutation/write-group-state-mutation-behavior.test.ts',
  'mutation/write-group-state-mutation-convergence.test.ts',
  'mutation/write-group-state-mutation-equivalence.test.ts',
  'mutation/write-group-state-mutation-presence.test.ts',
  'mutation/write-group-state-mutation.test.ts',
  'persistence/group-state-authority-fence.test.ts',
  'persistence/group-state-repository-corruption.test.ts',
  'persistence/group-state-repository-dispatch.test.ts',
  'persistence/group-state-repository-identity.test.ts',
  'persistence/group-state-repository-read-integrity.test.ts',
  'persistence/group-state-repository-write-integrity.test.ts',
  'persistence/group-state-snapshot-assembly.test.ts',
  'persistence/group-state-storage-keys.test.ts',
  'presence/group-presence-concurrency.test.ts',
  'presence/group-presence-expiry-retry.test.ts',
  'presence/group-presence-retry-test-runtime.ts',
  'presence/group-presence-retry.test.ts',
  'presence/group-presence-summary-evaluation-time.test.ts',
  'presence/group-presence-summary-storage-revision.test.ts',
  'presence/group-presence-summary-validation.test.ts',
  'presence/group-presence-summary-work.test.ts',
  'presence/group-presence-test-runtime.ts',
  'presence/reconcile-expired-group-presence.test.ts',
  'snapshot/group-state-snapshot-presence.test.ts',
  'snapshot/group-state-snapshot-read-through-cache.test.ts',
  'snapshot/group-state-snapshot-test-fixtures.ts',
] as const;

const constructionHelperPaths = [
  'group-state-concurrency-test-fixtures.ts',
  'group-state-test-mutation-executor.ts',
  'group-state-test-runtime.ts',
  'presence/group-presence-summary-evaluation-time.test.ts',
  'snapshot/group-state-snapshot-read-through-cache.test.ts',
  'snapshot/group-state-snapshot-test-fixtures.ts',
] as const;

interface NamedFunctionSize {
  readonly filePath: string;
  readonly name: string;
  readonly lines: number;
}

describe('group-state test structure', () => {
  it('keeps the exact responsibility-owned target tree and removes the predecessor', () => {
    expect(existsSync(predecessorPath), predecessorPath).toBe(false);
    expect(readRelativeFileTree(groupStateTestRoot)).toEqual([...expectedTargetTree].sort());
  });

  it('keeps every responsibility-owned TypeScript module within 400 physical lines', () => {
    const oversizedModules = readRelativeFileTree(groupStateTestRoot)
      .filter((filePath) => filePath.endsWith('.ts'))
      .map((filePath) => ({
        filePath,
        lines: physicalLineCount(readFile(path.join(groupStateTestRoot, filePath))),
      }))
      .filter(({ lines }) => lines > 400);

    expect(oversizedModules).toEqual([]);
  });

  it('keeps materially split general helpers within 60 physical lines', () => {
    const oversizedHelpers = constructionHelperPaths
      .flatMap((filePath) => readNamedFunctions(filePath))
      .filter(({ lines }) => lines > 60);

    expect(oversizedHelpers).toEqual([]);
  });
});

function readRelativeFileTree(directoryPath: string, prefix = ''): readonly string[] {
  return readdirSync(directoryPath, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.posix.join(prefix, entry.name);
      const absolutePath = path.join(directoryPath, entry.name);
      return entry.isDirectory()
        ? readRelativeFileTree(absolutePath, relativePath)
        : [relativePath];
    })
    .sort();
}

function physicalLineCount(source: string): number {
  return source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length;
}

function readNamedFunctions(relativePath: string): readonly NamedFunctionSize[] {
  const targetPath = path.join(groupStateTestRoot, relativePath);
  const legacyPath = path.join(repoRoot, 'packages/tests/shared-server', relativePath);
  const source = readFile(existsSync(targetPath) ? targetPath : legacyPath);
  const syntaxTree = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
  });

  return syntaxTree.program.body.flatMap((statement) => {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'FunctionDeclaration' && declaration.id && declaration.loc) {
      return [
        {
          filePath: relativePath,
          name: declaration.id.name,
          lines: declaration.loc.end.line - declaration.loc.start.line + 1,
        },
      ];
    }
    if (declaration?.type === 'ClassDeclaration') {
      return declaration.body.body.flatMap((member) => {
        if (member.type !== 'ClassMethod' || !member.loc) return [];
        const name = member.key.type === 'Identifier' ? member.key.name : '<computed>';
        return [
          {
            filePath: relativePath,
            name,
            lines: member.loc.end.line - member.loc.start.line + 1,
          },
        ];
      });
    }
    return [];
  });
}

function readFile(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}
