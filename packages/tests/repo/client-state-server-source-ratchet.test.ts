import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const expectedCohortFiles = [
  'README.md',
  'client-state-contract-validation.ts',
  'client-mutation-receipt-validation.ts',
  'client-state-semantic-equality.ts',
  'client-state-validation-primitives.ts',
  'mutation/validate-client-expired-session-authority.ts',
  'mutation/client-mutation-authority.ts',
  'mutation/client-mutation-command.ts',
  'mutation/client-mutation-contracts.ts',
  'mutation/command-validation/validate-client-mutation-command.ts',
  'mutation/command-validation/validate-client-mutation-operation-input.ts',
  'mutation/command-validation/validate-client-mutation-request.ts',
  'mutation/compute/compute-client-instance-mutation.ts',
  'mutation/compute/compute-client-mutation-result.ts',
  'mutation/compute/compute-client-mutation-state.ts',
  'mutation/compute/compute-client-mutation.ts',
  'mutation/compute/compute-client-principal-mutation.ts',
  'mutation/compute/compute-client-session-connect.ts',
  'mutation/compute/compute-client-session-disconnect.ts',
  'mutation/compute/compute-client-session-expiry.ts',
  'mutation/compute/compute-client-session-heartbeat.ts',
  'mutation/result-validation/validate-client-mutation-authority-policy.ts',
  'mutation/result-validation/validate-client-mutation-read.ts',
  'mutation/result-validation/validate-client-mutation-result.ts',
  'mutation/result-validation/validate-client-mutation.ts',
  'client-presence-state.ts',
  'persistence/client-state-persistence-contracts.ts',
  'persistence/client-state-runtime-namespaces.ts',
  'persistence/client-state-storage-keys.ts',
  'persistence/validate-persisted-client-state.ts',
  'persistence/client-state-persistence-codec.ts',
  'persistence/client-state-repository-reads.ts',
  'persistence/assemble-client-state-snapshot.ts',
  'persistence/client-state-snapshot-repository.ts',
  'persistence/client-state-repository.ts',
] as const;

describe('client-state server source ratchet', () => {
  it('keeps the cohort modules within the mechanical size limits', () => {
    for (const filePath of expectedCohortFiles.filter((value) => value.endsWith('.ts'))) {
      const source = read(`packages/shared-server/rallar-system/client-state/${filePath}`);
      expect(source.split('\n').length, filePath).toBeLessThanOrEqual(400);
      for (const size of functionSizes(source)) {
        expect(size.lines, `${filePath}:${size.name}`).toBeLessThanOrEqual(60);
      }
    }
  });
});

function functionSizes(source: string): readonly Readonly<{ name: string; lines: number }>[] {
  const program = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
  }).program;
  const sizes: Array<Readonly<{ name: string; lines: number }>> = [];
  visit(program, (node) => {
    const loc = node.loc as
      Readonly<{ start: Readonly<{ line: number }>; end: Readonly<{ line: number }> }> | undefined;
    if (!functionNodeTypes.has(String(node.type)) || !loc) return;
    sizes.push({
      name: functionName(node),
      lines: loc.end.line - loc.start.line + 1,
    });
  });
  return sizes;
}

function visit(value: unknown, action: (node: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) visit(item, action);
    return;
  }
  const node = value as Record<string, unknown>;
  if (typeof node.type === 'string') action(node);
  for (const [key, child] of Object.entries(node)) {
    if (key !== 'loc' && key !== 'start' && key !== 'end') visit(child, action);
  }
}

function functionName(node: Record<string, unknown>): string {
  const id = node.id as { name?: unknown } | undefined;
  const key = node.key as { name?: unknown } | undefined;
  if (typeof id?.name === 'string') return id.name;
  if (typeof key?.name === 'string') return key.name;
  return String(node.type);
}

function read(filePath: string): string {
  return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

const functionNodeTypes = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
]);
