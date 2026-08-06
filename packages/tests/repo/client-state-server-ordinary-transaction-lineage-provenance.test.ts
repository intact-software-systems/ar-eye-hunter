import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const base = '2fdba024bb347622727d337eb06fc13d2fe129fc';
const canonicalRoot = 'packages/shared-server/rallar-system/client-state';
const manifestPath = 'plans/repo-style-lineages/client-state-server-ordinary-transaction.json';
const ordinaryTransactionCanonicalPaths = [
  `${canonicalRoot}/client-state-service-contracts.ts`,
  `${canonicalRoot}/client-state-service.ts`,
  `${canonicalRoot}/client-state-service-timing.ts`,
  `${canonicalRoot}/mutation/read/read-client-mutation.ts`,
  `${canonicalRoot}/mutation/write/write-client-mutation.ts`,
  `${canonicalRoot}/inbox/app-client-inbox-contracts.ts`,
  `${canonicalRoot}/inbox/authenticated-client-mutation-ingress.ts`,
  `${canonicalRoot}/inbox/authorised-ws-client-app-inbox.ts`,
  `${canonicalRoot}/inbox/client-state-inbox-handler.ts`,
  `${canonicalRoot}/inbox/app-client-inbox-service.ts`,
] as const;
const expectedLineages = [
  {
    path: 'packages/shared-server/rallar-system/services/client-state-service.ts',
    blob: 'aa6c2483db49bfc2c819e14c37d64197a51064c7',
    targets: [
      'packages/shared-server/rallar-system/client-state/client-state-service-contracts.ts',
      'packages/shared-server/rallar-system/client-state/client-state-service.ts',
      'packages/shared-server/rallar-system/client-state/client-state-service-timing.ts',
      'packages/shared-server/rallar-system/client-state/mutation/read/read-client-mutation.ts',
      'packages/shared-server/rallar-system/client-state/mutation/write/write-client-mutation.ts',
    ],
  },
  {
    path: 'packages/shared-server/rallar-system/services/AppClientInboxService.ts',
    blob: '8f5d371f3693e135e17beeeef4781aba19c93a23',
    targets: [
      'packages/shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts',
      [
        'packages/shared-server/rallar-system/client-state/inbox/',
        'authenticated-client-mutation-ingress.ts',
      ].join(''),
      'packages/shared-server/rallar-system/client-state/inbox/client-state-inbox-handler.ts',
      'packages/shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts',
    ],
  },
] as const;

describe('client-state ordinary transaction lineage provenance', () => {
  it('binds every canonical Task 4B owner to one exact Task 4B predecessor', () => {
    expect(JSON.parse(read(manifestPath))).toEqual({
      version: 1,
      lineages: expectedLineages.map((lineage) => ({
        mergeBase: base,
        source: { path: lineage.path, blob: lineage.blob },
        targets: lineage.targets,
      })),
    });

    const targets = expectedLineages.flatMap((lineage) => lineage.targets);
    expect(new Set(targets).size).toBe(targets.length);
    for (const lineage of expectedLineages) {
      expect(readBlob(lineage.path), lineage.path).toBe(lineage.blob);
      for (const target of lineage.targets) expect(existsSync(absolute(target)), target).toBe(true);
    }
  });

  it('records the direct authorised-WS move outside structural capacity', () => {
    const provenance = read(
      'plans/repo-style-lineages/client-state-server-ordinary-transaction-provenance.md',
    );
    expect(
      readBlob('packages/shared-server/rallar-system/services/authorised-ws-client-app-inbox.ts'),
    ).toBe('490c3d4c3050ee3adf21a2b680aa4376357c3989');
    expect(provenance).toContain(
      'packages/shared-server/rallar-system/services/authorised-ws-client-app-inbox.ts',
    );
    expect(provenance).toContain(
      'packages/shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts',
    );
  });

  // prettier-ignore
  it(
    'owns the service, ordinary transaction, and AppInbox shell in the canonical client-state tree',
    () => {
      assertCanonicalOrdinaryTransactionOwnership();
    },
  );

  it('keeps the canonical command cohort acyclic and free of wildcard barrels', () => {
    assertCanonicalCommandCohortGraph();
  });

  it('keeps shared contract inventories below command validation', () => {
    assertSharedContractInventoryOwnership();
  });
});

function assertCanonicalOrdinaryTransactionOwnership(): void {
  const canonicalFiles = sourceFiles(canonicalRoot);
  expect(canonicalFiles).toEqual(expect.arrayContaining([...ordinaryTransactionCanonicalPaths]));

  const service = read(`${canonicalRoot}/client-state-service.ts`);
  const handler = read(`${canonicalRoot}/inbox/client-state-inbox-handler.ts`);
  const inboxService = read(`${canonicalRoot}/inbox/app-client-inbox-service.ts`);
  const timedService = read(`${canonicalRoot}/client-state-service-timing.ts`);

  expect(service).toContain('export function createClientStateService(');
  expect(handler).toContain('writeMutationWithAfterCommitResult');
  expect(handler).toContain('committedSnapshots');
  expect(inboxService).toContain('export class AppClientInboxService extends AppInboxService');
  expect(timedService).toContain('export function createTimedClientStateService(');

  for (const [compatibilityPath, owner] of [
    [
      'packages/shared-server/rallar-system/services/client-state-service.ts',
      '../client-state/client-state-service.ts',
    ],
    [
      'packages/shared-server/rallar-system/services/AppClientInboxService.ts',
      '../client-state/inbox/app-client-inbox-service.ts',
    ],
  ] as const) {
    const source = read(compatibilityPath);
    const program = parse(source, {
      sourceType: 'module',
      plugins: ['typescript'],
    }).program;
    expect(program.body.every((node) => node.type === 'ExportNamedDeclaration')).toBe(true);
    expect(importSpecifiers(source)).toContain(owner);
    expect(source).not.toContain('export *');
  }

  const sharedServerModule = read('packages/shared-server/mod.ts');
  expect(sharedServerModule).toContain(
    [
      'export { createClientStateService } from ',
      "'./rallar-system/client-state/client-state-service.ts';",
    ].join(''),
  );
  expect(sharedServerModule).toMatch(
    new RegExp(
      [
        'export\\s*\\{\\s*AppClientInboxService,?\\s*\\}\\s*from ',
        "'\\.\\/rallar-system\\/client-state\\/inbox\\/app-client-inbox-service\\.ts';",
      ].join(''),
    ),
  );
  expect(sharedServerModule).not.toContain(
    "export * from './rallar-system/client-state/client-state-service.ts';",
  );
  expect(sharedServerModule).not.toContain(
    "export * from './rallar-system/client-state/inbox/app-client-inbox-contracts.ts';",
  );
}

function assertCanonicalCommandCohortGraph(): void {
  const files = sourceFiles(canonicalRoot);
  const canonicalFiles = new Set(files);
  const graph = new Map(
    files.map((filePath) => [
      filePath,
      importSpecifiers(read(filePath))
        .filter((specifier) => specifier.startsWith('.'))
        .map((specifier) =>
          path.posix.normalize(path.posix.join(path.posix.dirname(filePath), specifier)),
        )
        .filter((target) => canonicalFiles.has(target)),
    ]),
  );

  for (const filePath of files) {
    expect(read(filePath), filePath).not.toContain('export *');
    expect(() => visitImportGraph(filePath, graph, [], new Set())).not.toThrow();
  }
}

function assertSharedContractInventoryOwnership(): void {
  for (const filePath of [
    `${canonicalRoot}/client-state-contract-validation.ts`,
    `${canonicalRoot}/client-mutation-receipt-validation.ts`,
    `${canonicalRoot}/client-state-validation-primitives.ts`,
    `${canonicalRoot}/mutation/client-mutation-contracts.ts`,
  ]) {
    expect(importSpecifiers(read(filePath)), filePath).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/mutation\/command-validation\//)]),
    );
  }

  const contracts = '../client-mutation-contracts.ts';
  const operationInput = [
    canonicalRoot,
    'mutation/command-validation/validate-client-mutation-operation-input.ts',
  ].join('/');
  for (const filePath of [
    operationInput,
    `${canonicalRoot}/mutation/command-validation/validate-client-mutation-command.ts`,
    `${canonicalRoot}/mutation/command-validation/validate-client-mutation-request.ts`,
  ]) {
    expect(importSpecifiers(read(filePath)), filePath).toContain(contracts);
  }
  expect(exportSpecifiers(read(operationInput))).toContain(contracts);
}

function visitImportGraph(
  filePath: string,
  graph: ReadonlyMap<string, readonly string[]>,
  stack: readonly string[],
  complete: Set<string>,
): void {
  if (stack.includes(filePath)) {
    throw new Error(`Canonical client-state import cycle: ${[...stack, filePath].join(' -> ')}`);
  }
  if (complete.has(filePath)) return;
  const nextStack = [...stack, filePath];
  for (const dependency of graph.get(filePath) ?? []) {
    visitImportGraph(dependency, graph, nextStack, complete);
  }
  complete.add(filePath);
}

function importSpecifiers(source: string): readonly string[] {
  const program = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
  }).program;
  return program.body.flatMap((node) => {
    if (
      (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration') &&
      node.source
    ) {
      return [node.source.value];
    }
    return [];
  });
}

function exportSpecifiers(source: string): readonly string[] {
  const program = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
  }).program;
  return program.body.flatMap((node) =>
    node.type === 'ExportNamedDeclaration' && node.source ? [node.source.value] : [],
  );
}

function sourceFiles(root: string): readonly string[] {
  return readdirSync(absolute(root), { withFileTypes: true })
    .flatMap((entry) => {
      const filePath = path.posix.join(root, entry.name);
      if (entry.isDirectory()) return sourceFiles(filePath);
      return entry.isFile() && entry.name.endsWith('.ts') ? [filePath] : [];
    })
    .sort();
}

function readBlob(filePath: string): string {
  return execFileSync('git', ['rev-parse', `${base}:${filePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

function absolute(filePath: string): string {
  return path.join(repoRoot, filePath);
}

function read(filePath: string): string {
  return readFileSync(absolute(filePath), 'utf8');
}
