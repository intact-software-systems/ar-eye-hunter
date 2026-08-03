import { parse } from '@babel/parser';
import path from 'node:path';

export interface NamedFunctionSize {
  readonly filePath: string;
  readonly name: string;
  readonly lines: number;
}

export interface RuntimeSource {
  readonly file: string;
  readonly raw: string;
}

export interface RuntimeCycleAnalysisInput {
  readonly repoRoot: string;
  readonly sources: readonly RuntimeSource[];
}

interface RuntimeDependencyVisitInput {
  readonly repoRoot: string;
  readonly start: string;
  readonly current: string;
  readonly edges: ReadonlyMap<string, readonly string[]>;
  readonly route: readonly string[];
  readonly visited: ReadonlySet<string>;
  readonly cycles: Set<string>;
}

export const expectedGroupStateTestTree = [
  'group-state-concurrency-test-fixtures.ts',
  'group-state-concurrency-test-runtime.ts',
  'group-state-service-idempotency-command.test.ts',
  'group-state-service-idempotency-concurrency.test.ts',
  'group-state-service-idempotency.test.ts',
  'group-state-service-timing-contract.test.ts',
  'group-state-service-timing-fixture.ts',
  'group-state-service-timing.test.ts',
  'group-state-test-mutation-executor.ts',
  'group-state-test-runtime.ts',
  'inbox/app-group-inbox-registration-lifecycle.test.ts',
  'inbox/group-state-inbox-authority.test.ts',
  'inbox/group-state-inbox-construction.test.ts',
  'inbox/group-state-inbox-descriptor-contract.test.ts',
  'inbox/group-state-inbox-operation-matrix.test.ts',
  'inbox/group-state-inbox-payload-contract.test.ts',
  'inbox/group-state-inbox-resource-fixtures.ts',
  'inbox/group-state-inbox-retry-convergence.test.ts',
  'inbox/group-state-inbox-retry.test.ts',
  'inbox/group-state-inbox-test-runtime.ts',
  'inbox/group-state-inbox-transaction-failures.test.ts',
  'inbox/group-state-inbox-transaction-result.test.ts',
  'inbox/group-state-transaction-boundary-fixture.ts',
  'mutation/group-aggregate-mutation-concurrency.test.ts',
  'mutation/group-aggregate-mutation.test.ts',
  'mutation/group-membership-mutation.test.ts',
  'mutation/group-mutation-request-validation.test.ts',
  'mutation/group-mutation-result-adaptation.test.ts',
  'mutation/group-mutation-result-persistence.test.ts',
  'mutation/group-mutation-result.test.ts',
  'mutation/group-mutation-test-runtime.ts',
  'mutation/group-presence-mutation.test.ts',
  'mutation/read-group-mutation-retry.test.ts',
  'mutation/read-group-mutation.test.ts',
  'mutation/validate-group-mutation-command.test.ts',
  'mutation/write-group-mutation-behavior.test.ts',
  'mutation/write-group-state-mutation-atomicity.test.ts',
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
  'presence/group-presence-connect-decision.test.ts',
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

export const taskSevenRepairProductionOwners = [
  'apps/api-v1/src/db/db.ts',
  'apps/api-v1/src/db/pglite-black-box-evidence-snapshot.ts',
  'apps/api-v1/src/db/pglite-sql-adapter.ts',
  'apps/api-v1/src/db/read-pglite-black-box-evidence.ts',
  'packages/shared-server/rallar-system/services/AppAdminInboxService.ts',
  'packages/shared-test/black-box-runner/api-v1-black-box-run.mts',
  'packages/shared-test/black-box-runner/managed-api/api-v1-managed-api-readiness.mts',
  'packages/shared-test/black-box-runner/managed-api/api-v1-managed-log-tail.mts',
  'packages/shared-test/black-box-runner/managed-api/api-v1-managed-api-redaction-patterns.mts',
  'packages/shared-test/black-box-runner/managed-api/api-v1-managed-postgres-run-database.mts',
  'packages/shared-test/black-box-runner/managed-api/api-v1-managed-process-lifecycle.mts',
  'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-contracts.ts',
  'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-derivation.ts',
  'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-source.ts',
  'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-sql.ts',
  'packages/shared-test/black-box-runner/api-v1-state-write-evidence.ts',
  'packages/shared-test/black-box-runner/read-api-v1-black-box-arg-values.mts',
] as const;

export const taskNineLayoutProductionOwners = [
  'packages/shared-test/black-box-runner/artifacts/artifact-reader.ts',
  'packages/shared-test/black-box-runner/artifacts/with-bounded-artifact-report-results.ts',
  'packages/shared-test/black-box-runner/artifacts/handoff-contract.ts',
  'packages/shared-test/black-box-runner/preflight/resolve-variable-by-env.ts',
  'packages/shared-test/black-box-runner/preflight/live-preflight.ts',
  'packages/shared-test/black-box-runner/preflight/plan-preflight.ts',
  'packages/shared-test/black-box-runner/state-write-evidence/api-v1-fairness-proof.ts',
  'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-command-codecs.ts',
  'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-group-causal-evidence.ts',
  'packages/shared-test/black-box-runner/state-write-evidence/read-intermediate-mutation-intents.ts',
  'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-json-evidence.ts',
  'packages/shared-test/black-box-runner/state-write-evidence/to-exact-persisted-evidence-matches.ts',
  'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-receipt-evidence.ts',
  'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-result-evidence.ts',
  'packages/shared-test/black-box-runner/state-write-evidence/validate-topology-mutation-result-payload.ts',
] as const;

export const taskSevenRepairTestOwners = [
  'apps/api-v1/test/db/managed-pglite-lifecycle.test.ts',
  'apps/api-v1/test/db/pglite-admin-prune-authority-correction.test.ts',
  'apps/api-v1/test/db/pglite-admin-prune-wake-transaction.test.ts',
  'apps/api-v1/test/db/pglite-black-box-evidence-snapshot.test.ts',
  'apps/api-v1/test/db/pglite-sql-adapter-date-parameters.test.ts',
  'apps/api-v1/test/db/pglite-sql-adapter-readiness-order.test.ts',
  'apps/api-v1/test/db/pglite-sql-adapter-timezone-child.ts',
  'packages/tests/shared-server/admin-prune-expired-work.test.ts',
  'packages/tests/shared-test/api-v1-managed-postgres-run-database.test.ts',
  'packages/tests/shared-test/api-v1-managed-process-lifecycle.test.ts',
  'packages/tests/shared-test/api-v1-state-write-evidence-source.test.ts',
] as const;

export const taskFiveReviewedPredecessorFunctionSizes: readonly NamedFunctionSize[] = [
  {
    filePath: 'packages/tests/shared-server/group-state/inbox/group-state-inbox-test-runtime.ts',
    name: 'runOperationMatrix',
    lines: 64,
  },
] as const;

export const taskNineReviewedPredecessorModuleSizes = [
  {
    filePath: 'packages/shared-server/rallar-system/services/AppInboxService.ts',
    lines: 729,
  },
] as const;

export const taskNineReviewedPredecessorFunctionSizes: readonly NamedFunctionSize[] = [
  {
    filePath: 'packages/shared-server/rallar-system/services/AppInboxService.ts',
    name: 'processEntryUntilCompletionInternal',
    lines: 71,
  },
  {
    filePath: 'packages/shared-server/rallar-system/services/AppInboxService.ts',
    name: 'onStateMessage',
    lines: 109,
  },
  {
    filePath: 'packages/shared-server/rallar-system/services/AppInboxService.ts',
    name: '<callback>',
    lines: 99,
  },
  {
    filePath: 'packages/shared-server/rallar-system/services/AppInboxService.ts',
    name: '<callback>',
    lines: 74,
  },
  ...taskFiveReviewedPredecessorFunctionSizes,
] as const;

export const reviewedPredecessorFunctionSizes: readonly NamedFunctionSize[] = [
  {
    filePath:
      'packages/tests/shared-server/group-state/inbox/group-state-inbox-operation-matrix.test.ts',
    name: 'runEveryAdvertisedGroupOperation',
    lines: 318,
  },
  {
    filePath: 'packages/tests/shared-server/group-state/inbox/group-state-inbox-test-runtime.ts',
    name: 'runOperationMatrix',
    lines: 64,
  },
  {
    filePath: 'packages/tests/shared-server/group-state/mutation/group-aggregate-mutation.test.ts',
    name: 'createMutationRead',
    lines: 62,
  },
  {
    filePath: 'packages/tests/shared-server/group-state/mutation/group-mutation-result.test.ts',
    name: 'createMutationRead',
    lines: 62,
  },
  {
    filePath: 'packages/tests/shared-server/group-state/mutation/group-presence-mutation.test.ts',
    name: 'createMutationRead',
    lines: 62,
  },
  {
    filePath:
      'packages/tests/shared-server/group-state/mutation/write-group-state-mutation-equivalence.test.ts',
    name: 'runScenario',
    lines: 64,
  },
  {
    filePath:
      'packages/tests/shared-server/group-state/persistence/group-state-storage-keys.test.ts',
    name: 'createMutationRead',
    lines: 62,
  },
] as const;

export function readRuntimeCycles({
  repoRoot,
  sources,
}: RuntimeCycleAnalysisInput): readonly string[] {
  const sourceByPath = new Map(sources.map((source) => [path.normalize(source.file), source]));
  const edges = new Map<string, readonly string[]>();
  for (const source of sources) {
    const syntaxTree = parse(source.raw, { sourceType: 'module', plugins: ['typescript'] });
    const dependencies = syntaxTree.program.body
      .flatMap((statement) => runtimeDependencySpecifiers(statement))
      .map((specifier) => resolveRelativeImport(source.file, specifier))
      .filter(
        (filePath): filePath is string => filePath !== undefined && sourceByPath.has(filePath),
      );
    edges.set(path.normalize(source.file), [...new Set(dependencies)].sort());
  }

  const cycles = new Set<string>();
  for (const start of edges.keys()) {
    visitRuntimeDependencies({
      repoRoot,
      start,
      current: start,
      edges,
      route: [],
      visited: new Set(),
      cycles,
    });
  }
  return [...cycles].sort();
}

function runtimeDependencySpecifiers(
  statement: ReturnType<typeof parse>['program']['body'][number],
): readonly string[] {
  if (statement.type === 'ImportDeclaration') {
    const hasRuntimeImport =
      statement.importKind !== 'type' &&
      (statement.specifiers.length === 0 ||
        statement.specifiers.some((specifier) => specifier.importKind !== 'type'));
    return hasRuntimeImport ? [statement.source.value] : [];
  }
  if (statement.type === 'ExportAllDeclaration') {
    return statement.exportKind !== 'type' ? [statement.source.value] : [];
  }
  if (statement.type === 'ExportNamedDeclaration' && statement.source) {
    const hasRuntimeExport =
      statement.exportKind !== 'type' &&
      statement.specifiers.some((specifier) => specifier.exportKind !== 'type');
    return hasRuntimeExport ? [statement.source.value] : [];
  }
  return [];
}

function visitRuntimeDependencies({
  repoRoot,
  start,
  current,
  edges,
  route,
  visited,
  cycles,
}: RuntimeDependencyVisitInput): void {
  if (visited.has(current)) {
    return;
  }
  const nextVisited = new Set(visited).add(current);
  const nextRoute = [...route, current];
  for (const dependency of edges.get(current) ?? []) {
    if (dependency === start) {
      cycles.add(
        [...nextRoute, start].map((filePath) => path.relative(repoRoot, filePath)).join(' -> '),
      );
    } else {
      visitRuntimeDependencies({
        repoRoot,
        start,
        current: dependency,
        edges,
        route: nextRoute,
        visited: nextVisited,
        cycles,
      });
    }
  }
}

function resolveRelativeImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) {
    return undefined;
  }
  return path.normalize(path.resolve(path.dirname(importer), specifier));
}
