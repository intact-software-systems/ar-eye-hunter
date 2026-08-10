export interface TopologyPrBTestCaseOwnership {
  readonly sourcePath: string;
  readonly sourceCaseId: string;
  readonly ownerPath: string;
  readonly ownerCaseId: string;
}

export const topologyPrBTestSourceCommit = '0b1fa13e07f7a8e4540d389cd5e25dfa95270da4';

const repositorySource = 'packages/tests/shared-server/group-topology-config-repository.test.ts';
const exactReadSource = 'packages/tests/shared-server/group-topology-mutation-exact-read.test.ts';
const persistenceRoot = 'packages/tests/shared-server/topology/config/persistence';

function moved(sourceCaseId: string, ownerName: string): TopologyPrBTestCaseOwnership {
  return {
    sourcePath: repositorySource,
    sourceCaseId,
    ownerPath: `${persistenceRoot}/${ownerName}.test.ts`,
    ownerCaseId: sourceCaseId,
  };
}

function movedExactRead(sourceCaseId: string): TopologyPrBTestCaseOwnership {
  return {
    sourcePath: exactReadSource,
    sourceCaseId,
    ownerPath: `${persistenceRoot}/group-topology-config-exact-read.test.ts`,
    ownerCaseId: sourceCaseId,
  };
}

export const movedTopologyPrBTestCases = [
  moved(
    'uses canonical optional-workspace keys across every topology namespace',
    'group-topology-config-repository-keys',
  ),
  ...[
    'retains the required workspace in stored values',
    'decodes canonical required-workspace sources consistently for list and page boundaries',
    'decodes legacy $label rows with omitted requestId as null',
    'commits config and overrides only against the observed storage revision',
    'stores durable config and temporary overrides by full group ref',
  ].map((caseId) => moved(caseId, 'group-topology-config-repository-read-write')),
  ...[
    'does not treat a malformed legacy row with an extra field as compatible',
    'rejects a generation backfill source with a missing group ref safely',
    'fails closed before lazy expiry can delete a wrong-scope override',
    'validates an expired %s value before lazy expiry and preserves corruption',
    'requires the %s physical row to be non-expiring',
    'requires $target physical expiry to agree at the $boundary boundary',
  ].map((caseId) => moved(caseId, 'group-topology-config-repository-corruption')),
  ...[
    'rejects noncanonical physical keys at list and page boundaries',
    'rejects a noncanonical physical key at every direct repository boundary',
    'rejects wrong stored scope or child identity at every direct boundary',
  ].map((caseId) => moved(caseId, 'group-topology-config-repository-scope-isolation')),
  ...[
    'rejects a persisted mutation record whose receipt commandId differs from requestId',
    'rejects persisted $label payloads',
    'rejects a persisted impossible %s no-op receipt as typed corruption',
    'rejects persisted $label',
  ].map((caseId) => moved(caseId, 'group-topology-config-mutation-record-corruption')),
  ...[
    'conditionally advances a retained per-target generation record',
    'optimistically backfills config and expired override generations without deleting sources',
    'does not downgrade a generation that wins a backfill conflict',
    'conditionally advances the retained aggregate invariant generation',
    'keeps expired override reads observational before a guarded refresh',
  ].map((caseId) => moved(caseId, 'group-topology-config-generation')),
  ...[
    'migrates a value-verified explicit-sentinel legacy source before generation backfill',
    'keeps ordinary per-ref readiness fail-closed without moving a legacy key',
    'does not claim an absent-workspace legacy source for the explicit sentinel',
    'fails closed without deleting a different-content canonical migration winner',
    'removes a semantically identical normalized migration duplicate',
    'rolls back a migration destination when the observed source revision changes',
    'pages all legacy migration candidates before generation backfill',
  ].map((caseId) => moved(caseId, 'group-topology-config-legacy-migration')),
  movedExactRead('reads every requested topology slot in one ordered batch snapshot'),
  movedExactRead(
    'omits the idempotency selector for query reads and falls back without batch support',
  ),
] as const;

export const topologyPrBOnlyCoverage = [
  [
    `${persistenceRoot}/group-topology-config-repository-keys.test.ts`,
    'keeps complete scoped and child identities injective for adversarial values',
  ],
  [
    `${persistenceRoot}/group-topology-config-repository-scope-isolation.test.ts`,
    'isolates identical group IDs across complete application and workspace scope',
  ],
  [
    `${persistenceRoot}/group-topology-config-repository-corruption.test.ts`,
    'wraps malformed live JSON as repository corruption',
  ],
  [
    `${persistenceRoot}/group-topology-config-exact-read.test.ts`,
    'treats equal-revision invariant content changes as a race and falls back',
  ],
] as const;
