import { parse } from '@babel/parser';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const ratchetedHelpers = [
  {
    filePath: 'packages/tests/shared-server/fixtures/postgres-app-inbox-worker-runtime.ts',
    functionName: 'createPostgresAppInboxWorkerRuntime',
  },
  {
    filePath: 'packages/tests/shared-server/fixtures/postgres-topology-app-outbox-worker.ts',
    functionName: 'runWorker',
  },
] as const;

describe('group-state server worker helper source ratchet', () => {
  it('keeps both materially split worker helpers within 60 physical lines', () => {
    const oversizedHelpers = ratchetedHelpers
      .map(({ filePath, functionName }) => ({
        filePath,
        functionName,
        lines: readFunctionLines(filePath, functionName),
      }))
      .filter(({ lines }) => lines > 60);

    expect(oversizedHelpers).toEqual([]);
  });
});

function readFunctionLines(filePath: string, functionName: string): number {
  const syntaxTree = parse(readFileSync(filePath, 'utf8'), {
    sourceType: 'module',
    plugins: ['typescript'],
  });
  for (const statement of syntaxTree.program.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (
      declaration?.type === 'FunctionDeclaration' &&
      declaration.id?.name === functionName &&
      declaration.loc
    ) {
      return declaration.loc.end.line - declaration.loc.start.line + 1;
    }
  }
  throw new Error(`Missing ratcheted function ${functionName} in ${filePath}`);
}
