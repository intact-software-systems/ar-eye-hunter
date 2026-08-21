import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isSupportedSourcePath } from './auth-server-compatibility-governance-validation.ts';
import {
  type ModuleReference,
  type NonliteralModuleReference,
  readModuleReferenceEvidence,
} from './auth-server-module-reference-validation.ts';

export interface AuthCompatibilityConsumerInventory {
  readonly compatibilityPath: string;
  readonly consumers: readonly string[];
  readonly identityConsumers: readonly string[];
  readonly governanceIdentityConsumers: readonly string[];
  readonly removalCondition: string;
}

export interface CompatibilityConsumerSourceInput {
  readonly readSource: (filePath: string) => string;
  readonly sourcePaths: readonly string[];
}

const runtimeIdentityGovernanceTest =
  'packages/tests/repo/auth-server-compatibility-runtime-identity.test.ts';

export const authCompatibilityConsumerInventory = [
  {
    compatibilityPath: 'packages/shared-server/rallar-system/services/AppAuthInboxService.ts',
    consumers: [
      'apps/api-v1/test/db/pglite-auth-app-inbox.test.ts',
      'apps/api-v1/test/db/pglite-auth-failure-atomicity.test.ts',
      'packages/shared-server/http/request-auth-service.ts',
      'packages/shared-server/rallar-system/middleware/rallar-middleware-options.ts',
      'packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts',
    ],
    identityConsumers: [
      'apps/api-v1/test/db/pglite-auth-app-inbox.test.ts',
      'apps/api-v1/test/db/pglite-auth-failure-atomicity.test.ts',
      'packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts',
    ],
    governanceIdentityConsumers: [runtimeIdentityGovernanceTest],
    removalCondition:
      'Migrate every listed caller to canonical inbox owners, then retire this service path.',
  },
  {
    compatibilityPath: 'packages/shared-server/rallar-system/services/auth-state-mutations.ts',
    consumers: [
      'apps/api-v1/test/db/pglite-auth-app-inbox.test.ts',
      'apps/api-v1/test/db/pglite-auth-failure-atomicity.test.ts',
      'apps/api-v1/test/db/pglite-auth-transaction-rollback.test.ts',
      'packages/shared-server/mod.ts',
      'packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts',
      'packages/tests/shared/authoritative-state-contracts.test.ts',
    ],
    identityConsumers: [
      'apps/api-v1/test/db/pglite-auth-app-inbox.test.ts',
      'apps/api-v1/test/db/pglite-auth-failure-atomicity.test.ts',
      'apps/api-v1/test/db/pglite-auth-transaction-rollback.test.ts',
      'packages/shared-server/mod.ts',
      'packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts',
    ],
    governanceIdentityConsumers: [runtimeIdentityGovernanceTest],
    removalCondition:
      'Move the package export and every listed caller to canonical mutation owners first.',
  },
  {
    compatibilityPath: 'packages/shared-server/rallar-system/services/auth-login-service.ts',
    consumers: ['apps/api-v1/src/services/api-login-service.ts'],
    identityConsumers: ['apps/api-v1/src/services/api-login-service.ts'],
    governanceIdentityConsumers: [runtimeIdentityGovernanceTest],
    removalCondition: 'Move the API-v1 login service to canonical login owners first.',
  },
  {
    compatibilityPath: 'packages/shared-server/rallar-system/services/auth-credential-issuer.ts',
    consumers: [
      'apps/api-v1/test/db/pglite-auth-app-inbox.test.ts',
      'apps/api-v1/test/db/pglite-auth-failure-atomicity.test.ts',
      'apps/api-v1/test/db/pglite-auth-transaction-rollback.test.ts',
      'packages/shared-server/http/production-env-hardening.ts',
      'packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts',
    ],
    identityConsumers: [
      'apps/api-v1/test/db/pglite-auth-app-inbox.test.ts',
      'apps/api-v1/test/db/pglite-auth-failure-atomicity.test.ts',
      'apps/api-v1/test/db/pglite-auth-transaction-rollback.test.ts',
      'packages/shared-server/http/production-env-hardening.ts',
      'packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts',
    ],
    governanceIdentityConsumers: [runtimeIdentityGovernanceTest],
    removalCondition:
      'Move every listed issuer or secret-validation caller to canonical credentials first.',
  },
  {
    compatibilityPath: 'packages/shared-server/rallar-system/repositories/AuthSessionRepository.ts',
    consumers: [
      'apps/api-v1/src/group-state/group-state-route-contracts.ts',
      'apps/api-v1/src/routes/client-state-routes.ts',
      'apps/api-v1/src/routes/graph-topology-routes.ts',
      'apps/api-v1/test/db/pglite-app-inbox-ws-close-test-harness.ts',
      'apps/api-v1/test/db/pglite-auth-app-inbox.test.ts',
      'apps/api-v1/test/db/pglite-auth-failure-atomicity.test.ts',
      'apps/api-v1/test/db/pglite-auth-test-harness.ts',
      'apps/api-v1/test/db/pglite-auth-transaction-rollback.test.ts',
      'apps/api-v1/test/db/pglite-client-event-collision-test-runtime.ts',
      'apps/api-v1/test/db/pglite-group-state-and-auth.test.ts',
      'apps/api-v1/test/db/pglite-runtime-state-and-collisions.test.ts',
      'apps/api-v1/test/db/pglite-state-mutation-test-runtime.ts',
      'apps/api-v1/test/db/pglite-topology-auth.test.ts',
      'apps/api-v1/test/db/pglite-topology-retry.test.ts',
      'apps/api-v1/test/db/pglite-topology-test-runtime.ts',
      'apps/api-v1/test/request-auth-service.test.ts',
      'apps/api-v1/test/routes/agent-session-ticket-route.test.ts',
      'apps/api-v1/test/routes/black-box-control-token-route.test.ts',
      'packages/shared-server/http/request-auth-service.ts',
      'packages/shared-server/postgres/rallar-system/createStateRepositories.ts',
      'packages/shared-server/rallar-system/client-state/client-state-service.ts',
      'packages/shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts',
      'packages/shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts',
      'packages/shared-server/rallar-system/client-state/inbox/' +
        'authenticated-client-mutation-ingress.ts',
      'packages/shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts',
      'packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts',
      'packages/shared-server/rallar-system/client-state/mutation/read/read-client-mutation.ts',
      'packages/shared-server/rallar-system/group-state/group-mutation-authority.ts',
      'packages/shared-server/rallar-system/group-state/group-state-service-contracts.ts',
      'packages/shared-server/rallar-system/group-state/presence/group-session-cleanup.ts',
      'packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts',
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
      'packages/tests/shared-server/group-state/group-state-test-runtime.ts',
      'packages/tests/shared-server/group-state/inbox/group-state-inbox-authority.test.ts',
      'packages/tests/shared-server/group-state/inbox/group-state-inbox-test-runtime.ts',
      'packages/tests/shared-server/group-state/inbox/group-state-transaction-boundary-fixture.ts',
      'packages/tests/shared-server/rallar-system/topology/concurrency/' +
        'postgres-topology-app-inbox-worker.ts',
      'scripts/perf/api-v1-state-write-concurrency-bench.ts',
      'scripts/perf/create-state-write-service-runtime.ts',
      'scripts/perf/group-list-fanout-bench.ts',
    ],
    identityConsumers: [
      'apps/api-v1/test/db/pglite-app-inbox-ws-close-test-harness.ts',
      'apps/api-v1/test/db/pglite-auth-app-inbox.test.ts',
      'apps/api-v1/test/db/pglite-auth-failure-atomicity.test.ts',
      'apps/api-v1/test/db/pglite-auth-test-harness.ts',
      'apps/api-v1/test/db/pglite-auth-transaction-rollback.test.ts',
      'apps/api-v1/test/db/pglite-client-event-collision-test-runtime.ts',
      'apps/api-v1/test/db/pglite-group-state-and-auth.test.ts',
      'apps/api-v1/test/db/pglite-runtime-state-and-collisions.test.ts',
      'apps/api-v1/test/db/pglite-topology-auth.test.ts',
      'apps/api-v1/test/db/pglite-topology-retry.test.ts',
      'apps/api-v1/test/request-auth-service.test.ts',
      'packages/shared-server/postgres/rallar-system/createStateRepositories.ts',
      'packages/shared-server/rallar-system/client-state/client-state-service.ts',
      'packages/shared-server/rallar-system/client-state/mutation/read/read-client-mutation.ts',
      'packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts',
      'packages/tests/shared-server/app-inbox-ws-close-test-harness.ts',
      'packages/tests/shared-server/client-state/app-client-inbox-authentication.test.ts',
      'packages/tests/shared-server/client-state/app-client-inbox-authorised-ws.test.ts',
      'packages/tests/shared-server/client-state/app-client-inbox-expiry-fixtures.ts',
      'packages/tests/shared-server/client-state/app-client-inbox-mutation-test-harness.ts',
      'packages/tests/shared-server/client-state/client-state-test-runtime.ts',
      'packages/tests/shared-server/client-state/postgres-client-mutation-test-driver.ts',
      'packages/tests/shared-server/fixtures/postgres-app-inbox-worker-services.ts',
      'packages/tests/shared-server/group-state/inbox/group-state-inbox-authority.test.ts',
      'packages/tests/shared-server/group-state/inbox/group-state-inbox-test-runtime.ts',
      'packages/tests/shared-server/group-state/inbox/group-state-transaction-boundary-fixture.ts',
      'scripts/perf/api-v1-state-write-concurrency-bench.ts',
      'scripts/perf/create-state-write-service-runtime.ts',
      'scripts/perf/group-list-fanout-bench.ts',
    ],
    governanceIdentityConsumers: [runtimeIdentityGovernanceTest],
    removalCondition:
      'Migrate every listed API, domain, fixture, and benchmark consumer to canonical persistence.',
  },
  {
    compatibilityPath: 'packages/shared-server/rallar-system/repositories/AuthUserRepository.ts',
    consumers: [
      'apps/api-v1/src/services/api-login-service.ts',
      'apps/api-v1/test/api-login-service.test.ts',
      'apps/api-v1/test/db/pglite-auth-app-inbox.test.ts',
      'packages/shared-server/postgres/rallar-system/createStateRepositories.ts',
    ],
    identityConsumers: [
      'apps/api-v1/test/api-login-service.test.ts',
      'apps/api-v1/test/db/pglite-auth-app-inbox.test.ts',
      'packages/shared-server/postgres/rallar-system/createStateRepositories.ts',
    ],
    governanceIdentityConsumers: [runtimeIdentityGovernanceTest],
    removalCondition:
      'Migrate every listed API and Postgres repository consumer to canonical persistence first.',
  },
] as const satisfies readonly AuthCompatibilityConsumerInventory[];

const repoRoot = process.cwd();
const compatibilityPaths: ReadonlySet<string> = new Set<string>(
  authCompatibilityConsumerInventory.map(({ compatibilityPath }) => compatibilityPath),
);
const governanceIdentityConsumerPaths: ReadonlySet<string> = new Set<string>(
  authCompatibilityConsumerInventory.flatMap(
    ({ governanceIdentityConsumers }) => governanceIdentityConsumers,
  ),
);
const allowedNonliteralReferences: Readonly<Record<string, readonly string[]>> = {
  'apps/api-v1/src/config-repo.ts': ['dynamic:fileName'],
  'apps/api-v1/test/operations/rtc-persisted-state-migration.test.ts': ['dynamic:moduleUrl.href'],
  'apps/relic-hunter-server-v1/src/config-repo.ts': ['dynamic:fileName'],
  'packages/shared-test/black-box-runner/rallar-browser-rtc-provider.ts': ['dynamic:specifier'],
  'packages/shared-test/black-box-runner/utils.ts': ['dynamic:fileName'],
  'packages/tests/hetzner/cloudflare-main-only-branch-controls.test.ts': ['dynamic:scriptUrl'],
  'packages/tests/repo/auth-mutation-validation-ownership.test.ts': [
    "dynamic:absolute('packages/shared-server/mod.ts')",
  ],
  'packages/tests/shared-web/shared-web-browser-entrypoints.test.ts': [
    'dynamic:entrypoint.moduleId',
  ],
};

interface ConsumerSourceEvidence {
  readonly filePath: string;
  readonly references: readonly ModuleReference[];
}

let cachedRepositoryEvidence: readonly ConsumerSourceEvidence[] | undefined;

export function readAuthCompatibilityConsumers(
  input?: CompatibilityConsumerSourceInput,
): ReadonlyMap<string, readonly string[]> {
  return readConsumers('all', input);
}

export function readAuthCompatibilityIdentityConsumers(
  input?: CompatibilityConsumerSourceInput,
): ReadonlyMap<string, readonly string[]> {
  return readConsumers('identity', input);
}

export function readAuthCompatibilityGovernanceIdentityConsumers(
  input?: CompatibilityConsumerSourceInput,
): ReadonlyMap<string, readonly string[]> {
  return readConsumers('governance-identity', input);
}

function readConsumers(
  classification: 'all' | 'governance-identity' | 'identity',
  input?: CompatibilityConsumerSourceInput,
): ReadonlyMap<string, readonly string[]> {
  const consumers = new Map<string, string[]>(
    [...compatibilityPaths].map((compatibilityPath) => [compatibilityPath, []]),
  );
  for (const { filePath, references } of readConsumerSourceEvidence(input)) {
    const governanceIdentity = governanceIdentityConsumerPaths.has(filePath);
    for (const reference of references) {
      if (classification === 'governance-identity' && !governanceIdentity) continue;
      if (classification !== 'governance-identity' && governanceIdentity) continue;
      if (classification !== 'all' && !reference.requiresRuntimeIdentity) continue;
      const resolved = resolveModuleSpecifier(filePath, reference.specifier);
      if (compatibilityPaths.has(resolved)) consumers.get(resolved)?.push(filePath);
    }
  }
  return new Map([...consumers].map(([owner, paths]) => [owner, [...new Set(paths)].sort()]));
}

function readConsumerSourceEvidence(
  input?: CompatibilityConsumerSourceInput,
): readonly ConsumerSourceEvidence[] {
  if (!input && cachedRepositoryEvidence) return cachedRepositoryEvidence;
  const sources = input ?? {
    sourcePaths: readSourceFiles(),
    readSource: (filePath: string) => readFileSync(path.join(repoRoot, filePath), 'utf8'),
  };
  const evidence = sources.sourcePaths.map((filePath) => {
    const parsed = readModuleReferenceEvidence(filePath, sources.readSource(filePath));
    requireAllowedNonliteralReferences(filePath, parsed.nonliteral);
    return { filePath, references: parsed.references };
  });
  requireAllAllowlistedSources(sources.sourcePaths);
  if (!input) cachedRepositoryEvidence = evidence;
  return evidence;
}

function requireAllAllowlistedSources(sourcePaths: readonly string[]): void {
  const scannedPaths = new Set(sourcePaths);
  const missingPath = Object.keys(allowedNonliteralReferences).find(
    (allowedPath) => !scannedPaths.has(allowedPath),
  );
  if (missingPath) throw new SyntaxError(`${missingPath}: missing allowlisted source path`);
}

function requireAllowedNonliteralReferences(
  filePath: string,
  references: readonly NonliteralModuleReference[],
): void {
  const capacity = [...(allowedNonliteralReferences[filePath] ?? [])];
  for (const reference of references) {
    const key = `${reference.kind}:${reference.expression}`;
    const index = capacity.indexOf(key);
    if (index < 0) throw new SyntaxError(`${filePath}: nonliteral module reference: ${key}`);
    capacity.splice(index, 1);
  }
  const missingReference = capacity[0];
  if (missingReference) {
    throw new SyntaxError(
      `${filePath}: missing allowlisted nonliteral module reference: ${missingReference}`,
    );
  }
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
    return entry.isFile() && isSupportedSourcePath(entryPath) ? [relative(entryPath)] : [];
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
