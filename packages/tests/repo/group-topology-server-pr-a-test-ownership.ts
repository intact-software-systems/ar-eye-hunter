export interface MovedTopologyTestCaseMapping {
  readonly sourcePath: string;
  readonly sourceCaseId: string;
  readonly ownerPath: string;
  readonly ownerCaseId: string;
  readonly supportPaths?: readonly string[];
  readonly allowedSupportSymbols?: readonly string[];
}

export interface TopologyTestSupportDeclaration {
  readonly ownerPath: string;
  readonly symbol: string;
}

export interface MovedTopologyTestSupportDeclaration {
  readonly sourcePath: string;
  readonly sourceSymbol: string;
  readonly ownerPath: string;
  readonly ownerSymbol: string;
  readonly allowedOwnerSymbols: readonly string[];
}

export const topologyTestSourceCommit = '8b1ebf542d12c05a5ac226d3d07e543a171a2626';

const configSource = 'packages/tests/shared-server/group-topology-config-service.test.ts';
const contractSource = 'packages/tests/shared-server/topology-app-inbox-contract.test.ts';
const authoritySource = 'packages/tests/shared-server/topology-app-inbox-authority.test.ts';
const handlerSource = 'packages/tests/shared-server/topology-app-inbox-handler.test.ts';
const ownershipSource = 'packages/tests/shared-server/topology-app-inbox-ownership.test.ts';
const resolutionOwner =
  'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts';
const computeOwner =
  'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts';
const idempotencyOwner =
  'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-idempotency.test.ts';
const validationOwner =
  'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts';
const resultOwner =
  'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-result.test.ts';
const boundaryOwner =
  'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-boundary.test.ts';
const fixtureOwner =
  'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts';
const commandOwner =
  'packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts';
const authorityOwner =
  'packages/tests/shared-server/topology/inbox/topology-app-inbox-authority.test.ts';
const handlerOwner =
  'packages/tests/shared-server/topology/inbox/topology-app-inbox-handler.test.ts';
const ownershipOwner =
  'packages/tests/shared-server/topology/inbox/topology-app-inbox-ownership.test.ts';

function moved(
  sourcePath: string,
  sourceCaseId: string,
  ownerPath: string,
  ownerCaseId = sourceCaseId,
  supportPaths?: readonly string[],
): MovedTopologyTestCaseMapping {
  return { sourcePath, sourceCaseId, ownerPath, ownerCaseId, supportPaths };
}

export const movedTopologyTestCases = [
  moved(
    configSource,
    'keeps synchronous reconfigure options off config mutation requests',
    resolutionOwner,
  ),
  moved(
    configSource,
    'computes and validates the same immutable config mutation twice',
    computeOwner,
    undefined,
    [fixtureOwner],
  ),
  moved(
    configSource,
    'clears durable and override fields back to their immediate fallback',
    computeOwner,
    undefined,
    [fixtureOwner],
  ),
  moved(
    configSource,
    'rejects an invalid durable config even when a temporary override hides it until expiry',
    validationOwner,
    undefined,
    [fixtureOwner],
  ),
  moved(
    configSource,
    'denies expired and terminal lifecycle mutations to platform admins',
    validationOwner,
    undefined,
    [fixtureOwner],
  ),
  moved(
    configSource,
    'rejects compact replay receipt operation corruption against the verified command',
    idempotencyOwner,
    undefined,
    [fixtureOwner],
  ),
  moved(
    configSource,
    'rejects an impossible %s no-op receipt at the pure validator boundary',
    resultOwner,
    undefined,
    [fixtureOwner],
  ),
  moved(
    configSource,
    'rejects an elapsed stable override expiry with explicit pure facts',
    validationOwner,
    'rejects an elapsed stable override expiry from pure facts',
    [fixtureOwner],
  ),
  moved(
    configSource,
    'keeps pure topology config phases ambient-free and orchestration visible',
    computeOwner,
    undefined,
    [fixtureOwner],
  ),
  moved(
    configSource,
    'resolves server defaults, durable config, temporary override, and request options',
    resolutionOwner,
    'resolves defaults, durable config, temporary override, and request options in order',
  ),
  moved(
    configSource,
    'defaults server config to auto topology plus threshold defaults',
    resolutionOwner,
    'preserves default values and rejects invalid patches and effective combinations',
  ),
  moved(
    configSource,
    'rejects invalid topology config patches and effective config combinations',
    resolutionOwner,
    'preserves default values and rejects invalid patches and effective combinations',
  ),
  moved(
    configSource,
    'defaults temporary override expiry to 15 minutes and caps it at 24 hours',
    resolutionOwner,
    'defaults override expiry to 15 minutes, caps it at 24 hours, and rejects elapsed values',
  ),
  moved(
    configSource,
    'rejects temporary override expiries that are not in the future',
    resolutionOwner,
    'defaults override expiry to 15 minutes, caps it at 24 hours, and rejects elapsed values',
  ),
  moved(
    contractSource,
    'binds $operation to its exact queue type and durable payload',
    commandOwner,
  ),
  moved(
    contractSource,
    'keeps HTTP topology identity stable across retry clocks and durable preparation changes',
    commandOwner,
  ),
  moved(
    contractSource,
    'collides divergent stable topology semantics behind the same request id',
    commandOwner,
  ),
  moved(contractSource, 'rejects unknown sparse request keys before durable enqueue', commandOwner),
  moved(
    contractSource,
    'canonicalizes omitted, set, and JSON-null clear actions exactly',
    commandOwner,
  ),
  moved(
    contractSource,
    'treats set and clear as divergent stable topology semantics',
    commandOwner,
  ),
  moved(
    contractSource,
    'validates and hashes an observable payload exactly once per required phase',
    commandOwner,
  ),
  moved(
    authoritySource,
    'binds enqueue authority to the current session and rechecks it on every attempt',
    authorityOwner,
  ),
  moved(
    authoritySource,
    'rejects proof, command-hash, and durable authority corruption',
    authorityOwner,
  ),
  moved(
    authoritySource,
    'compares equal proofs and rejects first, last, and length differences',
    authorityOwner,
  ),
  moved(
    handlerSource,
    'keeps verification and read-compute-validate-write phases ordered and wakes after commit',
    handlerOwner,
  ),
  moved(
    handlerSource,
    'rejects an idempotency conflict before opening a transaction or waking the queue',
    handlerOwner,
  ),
  moved(
    ownershipSource,
    'keeps the exact seven responsibility owners in the approved target tree',
    ownershipOwner,
  ),
  moved(
    ownershipSource,
    'keeps public topology command compatibility as a direct one-hop export',
    ownershipOwner,
  ),
  moved(
    ownershipSource,
    'keeps the public facade free of topology and RTC RTT mutation algorithms',
    ownershipOwner,
  ),
  moved(
    ownershipSource,
    'keeps handler imports directed toward contracts, authority, and retained services',
    ownershipOwner,
  ),
  moved(
    ownershipSource,
    'keeps predecessor setters only on the facade and passes complete handler dependencies',
    ownershipOwner,
  ),
  moved(
    ownershipSource,
    'keeps every materially changed production owner within the hard file limit',
    ownershipOwner,
  ),
  moved(
    ownershipSource,
    'keeps materially changed Task 6 test support within the hard file limit',
    ownershipOwner,
    'keeps directly owned mutation-routing and authoritative test support within the limit',
  ),
] as const;

export const retainedTopologyCharacterizationOwners = [
  fixtureOwner,
  'packages/tests/shared-server/app-inbox-transaction.test.ts',
  'packages/tests/shared-server/group-state/inbox/group-state-inbox-test-runtime.ts',
  'packages/tests/shared-server/topology/config/persistence/group-topology-config-exact-read.test.ts',
  'packages/tests/shared-server/topology-app-inbox-transaction.test.ts',
] as const;

export const movedTopologyTestSupportDeclarations = [
  movedSupport(configSource, 'createGroupRef', fixtureOwner, 'createTopologyTestGroupRef'),
  movedSupport(
    configSource,
    'createConfigMutationInput',
    fixtureOwner,
    'createTopologyConfigMutationTestInput',
    ['createTopologyConfigMutationRead', 'storedTopologyConfig', 'runtimeEntry'],
  ),
  movedSupport(
    configSource,
    'createGroupSnapshot',
    fixtureOwner,
    'createTopologyTestGroupSnapshot',
    ['topologyTestAuditStamp'],
  ),
  movedSupport(
    configSource,
    'createGroupAuthorityGuard',
    fixtureOwner,
    'createTopologyTestAuthorityGuard',
  ),
  movedSupport(configSource, 'deepFreeze', fixtureOwner, 'deepFreezeTopologyTestValue'),
  movedSupport(contractSource, 'topologyCommand', commandOwner, 'topologyCommand'),
  movedSupport(contractSource, 'logicalIdentity', commandOwner, 'logicalIdentity'),
  movedSupport(authoritySource, 'topologyCommand', authorityOwner, 'topologyCommand'),
  movedSupport(authoritySource, 'NOW_EPOCH_MS', authorityOwner, 'NOW_EPOCH_MS'),
  movedSupport(authoritySource, 'ISSUED_SESSION', authorityOwner, 'ISSUED_SESSION'),
  movedSupport(authoritySource, 'toPersistedSession', authorityOwner, 'toPersistedSession'),
  movedSupport(authoritySource, 'sessionReader', authorityOwner, 'sessionReader'),
  movedSupport(handlerSource, 'NOW_EPOCH_MS', handlerOwner, 'NOW_EPOCH_MS'),
  movedSupport(handlerSource, 'SESSION', handlerOwner, 'SESSION'),
  movedSupport(handlerSource, 'topologyContext', handlerOwner, 'topologyContext'),
  movedSupport(handlerSource, 'sessionReader', handlerOwner, 'sessionReader'),
  movedSupport(handlerSource, 'persistedSession', handlerOwner, 'persistedSession'),
  movedSupport(ownershipSource, 'serverRoot', ownershipOwner, 'serverRoot'),
  movedSupport(ownershipSource, 'testsRoot', ownershipOwner, 'testsRoot'),
  movedSupport(ownershipSource, 'targetOwners', ownershipOwner, 'targetOwners'),
  movedSupport(
    ownershipSource,
    'materiallyChangedOwners',
    ownershipOwner,
    'materiallyChangedOwners',
  ),
  movedSupport(
    ownershipSource,
    'materiallyChangedTestSupport',
    ownershipOwner,
    'materiallyChangedTestSupport',
  ),
  movedSupport(ownershipSource, 'readOwner', ownershipOwner, 'readOwner'),
] as const satisfies readonly MovedTopologyTestSupportDeclaration[];

export const topologyTestSupportDeclarations = [
  { ownerPath: boundaryOwner, symbol: 'boundaryFixtures' },
  { ownerPath: boundaryOwner, symbol: 'expectGenericBoundaryRecordsRejected' },
  { ownerPath: resolutionOwner, symbol: 'storedConfig' },
  { ownerPath: computeOwner, symbol: 'deterministicMutationInput' },
  { ownerPath: computeOwner, symbol: 'validateMutationRecord' },
  { ownerPath: computeOwner, symbol: 'readProductionSource' },
  { ownerPath: idempotencyOwner, symbol: 'runtimeEntry' },
  { ownerPath: fixtureOwner, symbol: 'createTopologyConfigMutationTestInput' },
  { ownerPath: fixtureOwner, symbol: 'createTopologyTestGroupRef' },
  { ownerPath: fixtureOwner, symbol: 'createTopologyTestGroupSnapshot' },
  { ownerPath: fixtureOwner, symbol: 'createTopologyTestAuthorityGuard' },
  { ownerPath: fixtureOwner, symbol: 'deepFreezeTopologyTestValue' },
  { ownerPath: fixtureOwner, symbol: 'createTopologyConfigMutationRead' },
  { ownerPath: fixtureOwner, symbol: 'storedTopologyConfig' },
  { ownerPath: fixtureOwner, symbol: 'runtimeEntry' },
  { ownerPath: fixtureOwner, symbol: 'topologyTestAuditStamp' },
  { ownerPath: commandOwner, symbol: 'topologyCommand' },
  { ownerPath: commandOwner, symbol: 'logicalIdentity' },
  { ownerPath: authorityOwner, symbol: 'topologyCommand' },
  { ownerPath: authorityOwner, symbol: 'NOW_EPOCH_MS' },
  { ownerPath: authorityOwner, symbol: 'ISSUED_SESSION' },
  { ownerPath: authorityOwner, symbol: 'toPersistedSession' },
  { ownerPath: authorityOwner, symbol: 'sessionReader' },
  { ownerPath: handlerOwner, symbol: 'NOW_EPOCH_MS' },
  { ownerPath: handlerOwner, symbol: 'SESSION' },
  { ownerPath: handlerOwner, symbol: 'topologyContext' },
  { ownerPath: handlerOwner, symbol: 'sessionReader' },
  { ownerPath: handlerOwner, symbol: 'persistedSession' },
  { ownerPath: ownershipOwner, symbol: 'serverRoot' },
  { ownerPath: ownershipOwner, symbol: 'testsRoot' },
  { ownerPath: ownershipOwner, symbol: 'targetOwners' },
  { ownerPath: ownershipOwner, symbol: 'materiallyChangedOwners' },
  { ownerPath: ownershipOwner, symbol: 'materiallyChangedTestSupport' },
  { ownerPath: ownershipOwner, symbol: 'readOwner' },
] as const satisfies readonly TopologyTestSupportDeclaration[];

export const taskTwoOnlyTopologyCoverage = [
  [boundaryOwner, 'owns complete operation validation before returning named domain contracts'],
  [boundaryOwner, 'preserves the validated object identity at every raw handoff'],
  [boundaryOwner, 'hands only exact named contracts to typed continuation validators'],
  [commandOwner, 'names the command map before indexing its exact operation union'],
  [commandOwner, 'binds every operation discriminant to exactly its request and durable payload'],
  [idempotencyOwner, 'returns a durable replay for the same command hash'],
  [idempotencyOwner, 'returns a typed conflict for divergent same-request semantics'],
  [validationOwner, 'rejects a candidate that differs from its deterministic recomputation'],
  [validationOwner, 'revalidates lifecycle authority at explicit attempt time'],
  [resultOwner, 'reconstructs the exact %s result from its durable receipt'],
  [resultOwner, 'preserves delete no-op reconstruction without an outbox'],
] as const;

function movedSupport(
  sourcePath: string,
  sourceSymbol: string,
  ownerPath: string,
  ownerSymbol: string,
  additionalOwnerSymbols: readonly string[] = [],
): MovedTopologyTestSupportDeclaration {
  return {
    sourcePath,
    sourceSymbol,
    ownerPath,
    ownerSymbol,
    allowedOwnerSymbols: [ownerSymbol, ...additionalOwnerSymbols],
  };
}
