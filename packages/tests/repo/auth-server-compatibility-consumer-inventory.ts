import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';

export interface AuthCompatibilityConsumerInventory {
  readonly compatibilityPath: string;
  readonly consumers: readonly string[];
  readonly removalCondition: string;
}

export const authCompatibilityConsumerInventory = [
  {
    compatibilityPath: 'packages/shared-server/rallar-system/services/AppAuthInboxService.ts',
    consumers: [
      'apps/api-v1/src/middleware-contract.ts',
      'apps/api-v1/src/middleware.ts',
      'apps/api-v1/src/routes/config-route.ts',
      'apps/api-v1/test/db/pglite-auth-app-inbox.test.ts',
      'apps/api-v1/test/db/pglite-auth-failure-atomicity.test.ts',
      'packages/shared-server/http/request-auth-service.ts',
      'packages/shared-server/rallar-system/middleware/rallar-middleware-options.ts',
      'packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts',
    ],
    removalCondition:
      'Migrate every listed caller to canonical inbox owners, then retire this service path.',
  },
  {
    compatibilityPath: 'packages/shared-server/rallar-system/services/auth-state-mutations.ts',
    consumers: [
      'apps/api-v1/src/middleware.ts',
      'apps/api-v1/test/db/pglite-auth-app-inbox.test.ts',
      'apps/api-v1/test/db/pglite-auth-failure-atomicity.test.ts',
      'apps/api-v1/test/db/pglite-auth-transaction-rollback.test.ts',
      'packages/shared-server/mod.ts',
      'packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts',
      'packages/tests/shared/authoritative-state-contracts.test.ts',
    ],
    removalCondition:
      'Move the package export and every listed caller to canonical mutation owners first.',
  },
  {
    compatibilityPath: 'packages/shared-server/rallar-system/services/auth-login-service.ts',
    consumers: ['apps/api-v1/src/repository/login-repository.ts'],
    removalCondition: 'Move the API-v1 login repository to canonical login owners first.',
  },
  {
    compatibilityPath: 'packages/shared-server/rallar-system/services/auth-credential-issuer.ts',
    consumers: [
      'apps/api-v1/src/middleware.ts',
      'apps/api-v1/test/db/pglite-auth-app-inbox.test.ts',
      'apps/api-v1/test/db/pglite-auth-failure-atomicity.test.ts',
      'apps/api-v1/test/db/pglite-auth-transaction-rollback.test.ts',
      'packages/shared-server/http/production-env-hardening.ts',
      'packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts',
    ],
    removalCondition:
      'Move every listed issuer or secret-validation caller to canonical credentials first.',
  },
  {
    compatibilityPath: 'packages/shared-server/rallar-system/repositories/AuthSessionRepository.ts',
    consumers: [
      'apps/api-v1/src/group-state/create-group-state-route-dependencies.ts',
      'apps/api-v1/src/group-state/group-state-route-contracts.ts',
      'apps/api-v1/src/repository/createStateRepositories.ts',
      'apps/api-v1/src/routes/client-state-routes.ts',
      'apps/api-v1/src/routes/config-route.ts',
      'apps/api-v1/src/routes/graph-topology-routes.ts',
      'apps/api-v1/src/services/request-auth-service.ts',
      'apps/api-v1/test/db/pglite-app-inbox-ws-close-test-harness.ts',
      'apps/api-v1/test/db/pglite-auth-app-inbox.test.ts',
      'apps/api-v1/test/db/pglite-auth-failure-atomicity.test.ts',
      'apps/api-v1/test/db/pglite-auth-test-harness.ts',
      'apps/api-v1/test/db/pglite-auth-transaction-rollback.test.ts',
      'apps/api-v1/test/db/pglite-sql-adapter.test.ts',
      'apps/api-v1/test/request-auth-service.test.ts',
      'apps/api-v1/test/routes/agent-session-ticket-route.test.ts',
      'apps/api-v1/test/routes/black-box-control-token-route.test.ts',
      'packages/shared-server/http/request-auth-service.ts',
      'packages/shared-server/postgres/rallar-system/createStateRepositories.ts',
      'packages/shared-server/rallar-system/client-state/client-state-service.ts',
      'packages/shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts',
      'packages/shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts',
      'packages/shared-server/rallar-system/client-state/inbox/authenticated-client-mutation-ingress.ts',
      'packages/shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts',
      'packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts',
      'packages/shared-server/rallar-system/client-state/mutation/read/read-client-mutation.ts',
      'packages/shared-server/rallar-system/group-state/group-mutation-authority.ts',
      'packages/shared-server/rallar-system/group-state/group-state-service-contracts.ts',
      'packages/shared-server/rallar-system/group-state/presence/group-session-cleanup.ts',
      'packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts',
      'packages/tests/shared-server/app-inbox-service.test.ts',
      'packages/tests/shared-server/app-inbox-ws-close-convergence.test.ts',
      'packages/tests/shared-server/app-inbox-ws-close-expiry.test.ts',
      'packages/tests/shared-server/app-inbox-ws-close-test-harness.ts',
      'packages/tests/shared-server/client-state/app-client-inbox-authentication.test.ts',
      'packages/tests/shared-server/client-state/app-client-inbox-authorised-ws.test.ts',
      'packages/tests/shared-server/client-state/app-client-inbox-expiry-fixtures.ts',
      'packages/tests/shared-server/client-state/app-client-inbox-mutation-test-harness.ts',
      'packages/tests/shared-server/client-state/client-state-test-runtime.ts',
      'packages/tests/shared-server/client-state/postgres-client-mutation-test-driver.ts',
      'packages/tests/shared-server/fixtures/postgres-app-inbox-worker-runtime.ts',
      'packages/tests/shared-server/fixtures/postgres-app-inbox-worker-services.ts',
      'packages/tests/shared-server/fixtures/postgres-expiry-worker.ts',
      'packages/tests/shared-server/fixtures/postgres-topology-app-inbox-worker.ts',
      'packages/tests/shared-server/group-state/group-state-test-runtime.ts',
      'packages/tests/shared-server/group-state/inbox/group-state-inbox-authority.test.ts',
      'packages/tests/shared-server/group-state/inbox/group-state-inbox-test-runtime.ts',
      'packages/tests/shared-server/group-state/inbox/group-state-transaction-boundary-fixture.ts',
      'scripts/perf/api-v1-state-write-concurrency-bench.ts',
      'scripts/perf/group-list-fanout-bench.ts',
    ],
    removalCondition:
      'Migrate every listed API, domain, fixture, and benchmark consumer to canonical persistence.',
  },
  {
    compatibilityPath: 'packages/shared-server/rallar-system/repositories/AuthUserRepository.ts',
    consumers: [
      'apps/api-v1/src/repository/createStateRepositories.ts',
      'apps/api-v1/src/repository/login-repository.ts',
      'apps/api-v1/test/db/pglite-auth-app-inbox.test.ts',
      'apps/api-v1/test/login-repository.test.ts',
      'packages/shared-server/postgres/rallar-system/createStateRepositories.ts',
    ],
    removalCondition:
      'Migrate every listed API and Postgres repository consumer to canonical persistence first.',
  },
] as const satisfies readonly AuthCompatibilityConsumerInventory[];

const repoRoot = process.cwd();
const compatibilityPaths: ReadonlySet<string> = new Set<string>(
  authCompatibilityConsumerInventory.map(({ compatibilityPath }) => compatibilityPath),
);

export function readAuthCompatibilityConsumers(): ReadonlyMap<string, readonly string[]> {
  const consumers = new Map<string, string[]>(
    [...compatibilityPaths].map((compatibilityPath) => [compatibilityPath, []]),
  );
  for (const filePath of readSourceFiles()) {
    for (const specifier of readStaticModuleSpecifiers(filePath)) {
      const resolved = resolveModuleSpecifier(filePath, specifier);
      if (compatibilityPaths.has(resolved)) consumers.get(resolved)?.push(filePath);
    }
  }
  return new Map([...consumers].map(([owner, paths]) => [owner, [...new Set(paths)].sort()]));
}

function readSourceFiles(): readonly string[] {
  return ['apps', 'packages', 'scripts'].flatMap((root) => sourceFiles(path.join(repoRoot, root)));
}

function sourceFiles(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && ['node_modules', 'dist', 'coverage'].includes(entry.name)) return [];
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [relative(entryPath)] : [];
  });
}

function readStaticModuleSpecifiers(filePath: string): readonly string[] {
  const source = readFileSync(path.join(repoRoot, filePath), 'utf8');
  let program;
  try {
    program = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'decorators-legacy'],
    }).program;
  } catch (error) {
    throw new SyntaxError(`${filePath}: ${String(error)}`);
  }
  return program.body.flatMap((statement) => {
    if (statement.type === 'ImportDeclaration') return [statement.source.value];
    if (statement.type === 'ExportAllDeclaration') return [statement.source.value];
    if (statement.type === 'ExportNamedDeclaration' && statement.source) {
      return [statement.source.value];
    }
    return [];
  });
}

function resolveModuleSpecifier(filePath: string, specifier: string): string {
  if (specifier.startsWith('@shared-server/')) {
    return path.posix.join('packages/shared-server', specifier.slice('@shared-server/'.length));
  }
  return specifier.startsWith('.')
    ? path.posix.normalize(path.posix.join(path.posix.dirname(filePath), specifier))
    : specifier;
}

function relative(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join(path.posix.sep);
}
