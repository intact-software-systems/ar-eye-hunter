export interface TopologyTestAtomTranslation {
  readonly sourcePath: string;
  readonly sourceCaseId: string;
  readonly sourceAtomId: string;
  readonly ownerPath: string;
  readonly ownerCaseId: string;
  readonly ownerAtomId: string;
  readonly reason: string;
}

const configSource = 'packages/tests/shared-server/group-topology-config-service.test.ts';
const idempotencyOwner =
  'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-idempotency.test.ts';
const fixtureOwner =
  'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts';
const computeOwner =
  'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts';
const validationOwner =
  'packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts';
const resolutionOwner =
  'packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts';
const ownershipSource = 'packages/tests/shared-server/topology-app-inbox-ownership.test.ts';
const ownershipOwner =
  'packages/tests/shared-server/topology/inbox/topology-app-inbox-ownership.test.ts';
const replayCase =
  'rejects compact replay receipt operation corruption against the verified command';
const ambientCase = 'keeps pure topology config phases ambient-free and orchestration visible';
const resolutionCase =
  'resolves server defaults, durable config, temporary override, and request options';
const resolutionTargetCase =
  'resolves defaults, durable config, temporary override, and request options in order';

function translation(
  sourceCaseId: string,
  sourceAtomId: string,
  ownerPath: string,
  ownerCaseId: string,
  ownerAtomId: string,
  reason: string,
): TopologyTestAtomTranslation {
  return {
    sourcePath: configSource,
    sourceCaseId,
    sourceAtomId,
    ownerPath,
    ownerCaseId,
    ownerAtomId,
    reason,
  };
}

export const topologyTestAtomTranslations = [
  translation(
    'computes and validates the same immutable config mutation twice',
    'assertion:96:4:expect().toThrow:3a2ce79e421b0e4c',
    computeOwner,
    'computes and validates the same immutable config mutation twice',
    'assertion:42:4:expect().toThrow:27e3fa22869ab7cc',
    'The extracted record-validation helper preserves the same hostile outbox-id rejection.',
  ),
  translation(
    'computes and validates the same immutable config mutation twice',
    'assertion:113:4:expect().toThrow:ac342b8171061761',
    computeOwner,
    'computes and validates the same immutable config mutation twice',
    'assertion:48:4:expect().toThrow:9833ca24dc5ed9d1',
    'The extracted record-validation helper preserves the same null accepted-config rejection.',
  ),
  translation(
    'computes and validates the same immutable config mutation twice',
    'assertion:127:4:expect().toThrow:5ea69a69e6a550fc',
    computeOwner,
    'computes and validates the same immutable config mutation twice',
    'assertion:51:4:expect().toThrow:4bb7a494b77ccbd8',
    'The extracted record-validation helper preserves the same invalid accepted-config rejection.',
  ),
  translation(
    'rejects an invalid durable config even when a temporary override hides it until expiry',
    'assertion:180:4:expect().toThrow:8b8ceede53ef30c1',
    validationOwner,
    'rejects an invalid durable config even when a temporary override hides it until expiry',
    'assertion:30:4:expect().toThrow:f37d380b08c38bc4',
    'The extracted fixture and compute owner preserve the same invalid durable-config rejection.',
  ),
  translation(
    'denies expired and terminal lifecycle mutations to platform admins',
    'assertion:214:6:expect().toThrow:bcdd88f28f2868a1',
    validationOwner,
    'denies expired and terminal lifecycle mutations to platform admins',
    'assertion:74:6:expect().toThrow:f90388e58a7b12ad',
    'The extracted lifecycle fixture preserves the same status and denial-code predicate.',
  ),
  translation(
    replayCase,
    'assertion:273:4:expect().toThrow:2e66f3001171f043',
    idempotencyOwner,
    replayCase,
    'assertion:75:4:expect().toThrow:a65cd8995ec19fdd',
    'The direct idempotency probe preserves the exact receipt-operation corruption error.',
  ),
  translation(
    replayCase,
    'raw-literal:260:15:property:read/property:idempotency/property:key:"corrupt-replay"',
    idempotencyOwner,
    'support:runtimeEntry',
    'raw-literal:83:9:function:runtimeEntry/property:key:"idempotency"',
    'The extracted runtimeEntry helper owns the stable idempotency lookup key.',
  ),
  translation(
    replayCase,
    'raw-literal:263:17:property:idempotency/property:entry/property:key:"corrupt-replay"',
    idempotencyOwner,
    'support:runtimeEntry',
    'raw-literal:86:11:function:runtimeEntry/property:entry/property:key:"idempotency"',
    'The extracted runtimeEntry helper owns the stable persisted entry key.',
  ),
  translation(
    'rejects an elapsed stable override expiry with explicit pure facts',
    'assertion:359:4:expect().toThrow:8320c0ff2ec9b12d',
    validationOwner,
    'rejects an elapsed stable override expiry from pure facts',
    'assertion:95:4:expect().toThrow:9bf4ade59511c604',
    'The extracted fixture preserves the same explicit expiry facts and validation error.',
  ),
  translation(
    'rejects an elapsed stable override expiry with explicit pure facts',
    'raw-literal:350:31:property:facts/property:commandHash/call:.repeat:"8"',
    fixtureOwner,
    'support:createTopologyConfigMutationTestInput',
    'raw-literal:45:27:variable:facts/property:commandHash/call:.repeat:"c"',
    'The extracted fixture owns a deterministic valid command-hash seed; the exact hash shape is unchanged.',
  ),
  translation(
    ambientCase,
    'raw-literal:365:8:variable:mutationSource/call:readFileSync:"../../shared-server/rallar-system/services/group-topology-config-mutations.ts"',
    computeOwner,
    ambientCase,
    'raw-literal:87:6:variable:mutationSource/call:readProductionSource:"topology/config/mutation/compute-topology-config-mutation.ts"',
    'The barrier follows the mutation implementation to its canonical owner.',
  ),
  translation(
    ambientCase,
    'raw-literal:385:8:variable:managementSource/call:readFileSync:"../../shared-server/rallar-system/services/group-topology-management-service.ts"',
    computeOwner,
    ambientCase,
    'raw-literal:102:50:variable:managementSource/call:readProductionSource:"services/group-topology-management-service.ts"',
    'The orchestration barrier retains its management-service consumer target.',
  ),
  translation(
    ambientCase,
    'raw-literal:392:8:variable:appInboxSource/call:readFileSync:"../../shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts"',
    computeOwner,
    ambientCase,
    'raw-literal:103:48:variable:appInboxSource/call:readProductionSource:"topology/inbox/topology-app-inbox-handler.ts"',
    'The orchestration barrier follows the handler to its canonical owner.',
  ),
  translation(
    resolutionCase,
    'fixture:433:16:variable:durable/property:groupRef:createGroupRef:c95f65de29bc1345',
    resolutionOwner,
    resolutionTargetCase,
    'fixture:31:20:variable:durable:storedConfig:725be956c9ca0c13',
    'The named storedConfig fixture now owns construction of the durable group reference.',
  ),
  supportTranslation(
    'serverRoot',
    'raw-literal:6:41:variable:serverRoot/call:fileURLToPath:"../../shared-server/rallar-system/"',
    'serverRoot',
    'raw-literal:9:10:variable:serverRoot/call:fileURLToPath:"../../../../shared-server/rallar-system/"',
    'The owner test moved two directories deeper while retaining the same shared-server root.',
  ),
  supportTranslation(
    'testsRoot',
    'raw-literal:7:40:variable:testsRoot/call:fileURLToPath:"./"',
    'testsRoot',
    'raw-literal:11:40:variable:testsRoot/call:fileURLToPath:"../../"',
    'The owner test moved two directories deeper while retaining the same shared-test root.',
  ),
  supportTranslation(
    'materiallyChangedTestSupport',
    'raw-literal:26:2:variable:materiallyChangedTestSupport:"topology-app-inbox-ownership.test.ts"',
    'materiallyChangedTestSupport',
    'raw-literal:31:2:variable:materiallyChangedTestSupport:"topology/inbox/topology-app-inbox-ownership.test.ts"',
    'The moved ownership test remains the same support owner at its canonical topology path.',
  ),
] as const satisfies readonly TopologyTestAtomTranslation[];

function supportTranslation(
  sourceSymbol: string,
  sourceAtomId: string,
  ownerSymbol: string,
  ownerAtomId: string,
  reason: string,
): TopologyTestAtomTranslation {
  return {
    sourcePath: ownershipSource,
    sourceCaseId: `support:${sourceSymbol}`,
    sourceAtomId,
    ownerPath: ownershipOwner,
    ownerCaseId: `support:${ownerSymbol}`,
    ownerAtomId,
    reason,
  };
}
