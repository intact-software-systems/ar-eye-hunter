import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findMutationBoundaryViolations } from './mutation-boundary-analysis.ts';
import {
  readFunctionBody as functionBody,
  readMethodBody as methodBody,
} from './authoritative-mutation-source-analysis.ts';
import { authoritativeMutationRuntimeSourcePaths } from './authoritative-mutation-runtime-source-inventory.ts';

// Retain permanently as cross-domain semantic phase-order evidence.
const read = (file: string): string => readFileSync(file, 'utf8');
const serviceRoot = 'packages/shared-server/rallar-system/services';
const authRoot = 'packages/shared-server/rallar-system/auth';
const repositoryRoot = 'packages/shared-server/rallar-system/repositories';
const groupStateRoot = 'packages/shared-server/rallar-system/group-state';
const topologyInboxRoot = 'packages/shared-server/rallar-system/topology/inbox';
const topologyRoot = 'packages/shared-server/rallar-system/topology';
const rtcInboxRoot = 'packages/shared-server/rallar-system/rtc-topology/inbox';
const persistenceRoot = `${groupStateRoot}/persistence`;
const validationPrimitivesPath = `${groupStateRoot}/group-state-validation-primitives.ts`;
const oldValidationPath = `${groupStateRoot}/mutation/group-state-validation-primitives.ts`;
const sharedValidationPrimitiveNames = [
  'assertExactKeys',
  'assertRequiredKeys',
  'requireOneOf',
  'requireRecord',
  'requireNonEmptyString',
  'nullableNonEmptyString',
  'requireNonNegativeSafeInteger',
  'requirePositiveSafeInteger',
  'nullablePositiveSafeInteger',
] as const;

const sources = {
  appAdmin: read(`${serviceRoot}/AppAdminInboxService.ts`),
  authHandler: read(`${authRoot}/inbox/auth-inbox-handler.ts`),
  appClient: read(
    'packages/shared-server/rallar-system/client-state/inbox/client-state-inbox-handler.ts',
  ),
  appCrdt: read(`${serviceRoot}/AppCrdtInboxService.ts`),
  appGroup: read(`${serviceRoot}/AppGroupInboxService.ts`),
  topologyHandler: read(`${topologyInboxRoot}/topology-app-inbox-handler.ts`),
  rtcHandler: read(`${rtcInboxRoot}/rtc-rtt-app-inbox-handler.ts`),
  groupHandler: read(`${groupStateRoot}/inbox/group-state-inbox-handler.ts`),
  groupService: read(`${groupStateRoot}/group-state-service.ts`),
  client: read(
    'packages/shared-server/rallar-system/client-state/mutation/write/write-client-mutation.ts',
  ),
  group: read(`${groupStateRoot}/mutation/write/write-group-mutation.ts`),
  topologyConfig: read(`${topologyRoot}/config/mutation/write-topology-config-mutation.ts`),
  topologyReconfigure: read(`${topologyRoot}/reconfigure/group-topology-reconfigure-mutation.ts`),
  topologyWorker: read(`${serviceRoot}/RtcTopologyOutboxWork.ts`),
  topologyRepository: read(`${repositoryRoot}/RtcTopologyExecutionRepository.ts`),
  rtt: read(`${serviceRoot}/rtc-rtt-mutation-service.ts`),
};

const trackedRuntimeSource = authoritativeMutationRuntimeSourcePaths.map(read).join('\n');

const removedIntermediateOutboxSymbols = [
  'state-mutation:' + 'outbox',
  'StateMutation' + 'OutboxRepository',
  'StateMutation' + 'OutboxWork',
] as const;
it('contains no intermediate state-mutation outbox runtime wiring', () => {
  for (const forbidden of removedIntermediateOutboxSymbols) {
    expect(trackedRuntimeSource).not.toContain(forbidden);
  }
});

it('keeps group-state service and inbox ownership in the target modules', () => {
  for (const file of [
    `${groupStateRoot}/group-mutation-authority.ts`,
    `${groupStateRoot}/group-mutation-command.ts`,
    `${groupStateRoot}/group-presence-mutation-command.ts`,
    `${groupStateRoot}/group-state-service-contracts.ts`,
    `${groupStateRoot}/group-state-service.ts`,
    `${groupStateRoot}/inbox/group-state-inbox-contracts.ts`,
    `${groupStateRoot}/inbox/group-state-inbox-handler.ts`,
    `${groupStateRoot}/inbox/to-group-mutation-descriptor.ts`,
    `${groupStateRoot}/inbox/group-state-inbox-result.ts`,
  ]) {
    expect(existsSync(file), file).toBe(true);
  }
  expect(read(`${serviceRoot}/group-state-service.ts`)).not.toContain('createGroupStateRuntime(');
  expect(read(`${serviceRoot}/group-state-service.ts`)).not.toContain('toDescriptorCommand(');
  expect(sources.groupHandler).toContain('export class GroupStateInboxHandler');
  expect(sources.groupService).not.toContain('../services/group-state-mutations.ts');
});

it('keeps persistence validators below mutation and stateful owners', () => {
  for (const file of [
    `${persistenceRoot}/validate-persisted-group.ts`,
    `${persistenceRoot}/validate-persisted-group-presence.ts`,
  ]) {
    const source = read(file);
    expect(source, file).not.toMatch(
      /from ['"](?:\.\.\/)+(?:mutation|services|inbox|repositories\/GroupStateRepository)(?:\/|\.ts)/,
    );
  }
});

it('keeps one implementation of each shared group-state validation primitive', () => {
  const validatorPaths = [
    `${persistenceRoot}/validate-persisted-group.ts`,
    `${persistenceRoot}/validate-persisted-group-presence.ts`,
  ];
  const ownerSources = [validationPrimitivesPath, oldValidationPath, ...validatorPaths]
    .filter(existsSync)
    .map(read)
    .join('\n');

  for (const name of sharedValidationPrimitiveNames) {
    expect(
      ownerSources.match(new RegExp(`function\\s+${name}\\s*\\(`, 'g')) ?? [],
      name,
    ).toHaveLength(1);
  }
});

it('keeps shared validation primitives in the feature root', () => {
  expect(existsSync(validationPrimitivesPath), validationPrimitivesPath).toBe(true);
  expect(existsSync(oldValidationPath), oldValidationPath).toBe(false);

  for (const file of [
    `${persistenceRoot}/validate-persisted-group.ts`,
    `${persistenceRoot}/validate-persisted-group-presence.ts`,
  ]) {
    expect(read(file), file).toContain("from '../group-state-validation-primitives.ts'");
  }
});

it.each([
  {
    name: 'auth AppInbox',
    source: sources.authHandler,
    owner: 'processAuthMutation',
    calls: [
      'this.dependencies.mutationService.read(command)',
      'captureAuthMutationFacts(command, this.dependencies.credentialIssuer)',
      'this.dependencies.mutationService.compute(command, read, facts)',
      'this.dependencies.mutationService.validate(command, read, computed)',
      'this.dependencies.transactionWriter.writeMutation(',
      'this.dependencies.mutationService.write(transaction, computed)',
    ],
  },
  {
    name: 'CRDT AppInbox',
    source: sources.appCrdt,
    owner: 'processCommand',
    calls: [
      'this.mutationService.read(command)',
      'this.mutationService.compute(command, read)',
      'this.mutationService.validate(command, read, computed)',
      'this.mutationService.write(transaction, computed)',
    ],
  },
  {
    name: 'admin AppInbox',
    source: sources.appAdmin,
    owner: 'processCommand',
    calls: [
      'this.read(command)',
      'this.compute(command, read)',
      'this.validate(command, read, computed)',
      'this.writeMutation(context',
    ],
  },
  {
    name: 'client AppInbox',
    source: sources.appClient,
    owner: 'processCommand',
    calls: [
      'this.dependencies.mutationService.read(command)',
      'this.dependencies.mutationService.compute(command, read)',
      'this.dependencies.mutationService.validate(command, read, computed)',
      'this.commitComputed(context, computed)',
    ],
  },
  {
    name: 'group AppInbox',
    source: sources.groupHandler,
    owner: 'processGroupStateMutation',
    calls: [
      'this.dependencies.mutationService.read(command)',
      'this.dependencies.mutationService.compute(command, read)',
      'this.dependencies.mutationService.validate(command, read, computed)',
      'this.commitMutation({ context, command, computed })',
    ],
  },
  {
    name: 'topology config AppInbox',
    source: sources.topologyHandler,
    owner: 'processMutation',
    calls: [
      'owners.configMutationService.read(',
      'owners.configMutationService.compute(',
      'owners.configMutationService.validate(',
      'this.dependencies.writeMutation(',
      'owners.writeConfigMutation(',
    ],
  },
  {
    name: 'topology reconfigure AppInbox',
    source: sources.topologyHandler,
    owner: 'processTopologyReconfigureMutation',
    calls: [
      'mutation.read(command)',
      'mutation.compute(command, read)',
      'mutation.validate(command, read, computed)',
      'this.dependencies.writeMutation(',
      'mutation.write(transaction, computed)',
    ],
  },
  {
    name: 'RTC RTT AppInbox',
    source: sources.rtcHandler,
    owner: 'processMutation',
    calls: [
      'readRttMutation(',
      'computeRttMutation(',
      'validateRttMutation(',
      'this.commitMutation(',
    ],
  },
])('$name keeps one visible read/compute/validate/write path', ({ source, owner, calls }) => {
  const body = methodBody(source, owner);
  expectInOrder(body, calls);
});

it('keeps every authoritative service write bound to the caller transaction', () => {
  const seams = [
    functionBody(sources.client, 'writeClientMutation'),
    functionBody(sources.group, 'writeGroupMutation'),
    functionBody(sources.topologyConfig, 'writeTopologyConfigMutation'),
    methodBody(sources.topologyReconfigure, 'write'),
    functionBody(sources.rtt, 'writeRttMutation'),
    methodBody(sources.topologyRepository, 'writeTopologyMutation'),
  ];
  for (const seam of seams) {
    expect(seam).toMatch(/transaction:\s*PSqlTransactionSql/);
    expect(seam).not.toMatch(/\.begin\s*\(/);
    expect(seam).not.toMatch(/waitForRuntimeStateWriteRetry/);
  }
});

it('keeps AppInbox as the only retry and transaction owner for HTTP and WS mutations', () => {
  for (const source of [
    sources.topologyConfig,
    sources.topologyReconfigure,
    sources.topologyRepository,
    sources.rtt,
    sources.topologyWorker,
  ]) {
    expect(source).not.toMatch(/waitForRuntimeStateWriteRetry/);
    expect(source).not.toMatch(/for\s*\([^)]*attempt/);
  }
  expect(sources.topologyHandler).toContain('this.dependencies.writeMutation(');
  expect(sources.rtcHandler).toContain('this.dependencies.writeMutation(');
  expect(sources.appGroup).toContain('AppInboxType.RTC_RTT_SUBMIT');
  expect(sources.appGroup).toContain('AppInboxType.TOPOLOGY_RECONFIGURE');
});

it('keeps transport boundaries free of direct mutators and persistence owners', () => {
  expect(findMutationBoundaryViolations()).toEqual([]);
}, 15_000);

it('writes topology config state, receipt, authority fence, and APP_OUTBOX atomically', () => {
  const seam = functionBody(sources.topologyConfig, 'writeTopologyConfigMutation');
  expectInOrder(seam, [
    'writeTopologyConfigAuthorityFence(',
    'writeTopologyConfigState(',
    'insertMutationRecord(',
    'writeRtcTopologyOutbox(transaction, computed.outbox)',
  ]);
  expectInOrder(functionBody(sources.topologyConfig, 'writeTopologyConfigAuthorityFence'), [
    'advanceAuthorityFence(',
    'computed.groupAuthorityGuard',
    'throw new RuntimeStateWriteConflictError()',
  ]);
  expect(seam).not.toContain('StateMutation' + 'Outbox');
});

it('fences explicit reconfigure authority before inserting APP_OUTBOX', () => {
  const seam = methodBody(sources.topologyReconfigure, 'write');
  expectInOrder(seam, [
    'advanceAuthorityFence(',
    'computed.authorityGuard',
    'throw new RuntimeStateWriteConflictError()',
    'writeRtcTopologyOutbox(transaction, computed)',
  ]);
});

it('writes RTT admission, measurement, receipt, and direct APP_OUTBOX rows atomically', () => {
  const seam = functionBody(sources.rtt, 'writeRttMutation');
  expectInOrder(seam, [
    'commitEndpointAdmission(',
    'commitMeasurement(',
    'insertMutationReceipt(',
    'writeRtcTopologyOutbox(transaction,',
  ]);
  expect(seam).not.toContain('insertRecomputeIntent');
  expect(seam).not.toContain('StateMutation' + 'Outbox');
});

it('keeps all topology and RTT computed effects direct and mandatory', () => {
  const topologyEntry = read(`${serviceRoot}/rtc-topology-outbox-entry.ts`);
  const topologyWsEntry = read(`${serviceRoot}/rtc-topology-ws-outbox-entry.ts`);
  for (const field of [
    'commandId',
    'resourceId',
    'aggregateRef',
    'acceptedCausalRevision',
    'groupSnapshot',
    'createdAtEpochMs',
    'expireAtEpochMs',
    'senderId',
    'requestOptions',
    'publish',
  ]) {
    expect(topologyEntry).toMatch(new RegExp(`readonly\\s+${field}(?!\\?)`));
  }
  expect(topologyWsEntry).toContain('EnqueuedType.WS_OUTBOX');
  expect(topologyEntry).toContain('EnqueuedType.APP_OUTBOX');
});

it('does not reintroduce intermediate state-mutation intents on Task 7 paths', () => {
  for (const source of [
    sources.appGroup,
    sources.topologyConfig,
    sources.topologyReconfigure,
    sources.rtt,
    sources.topologyWorker,
  ]) {
    expect(source).not.toContain('StateMutation' + 'OutboxWork');
  }
  expect(sources.topologyConfig).not.toContain('StateMutation' + 'OutboxRepository');
  expect(sources.rtt).not.toContain('insertRecomputeIntent');
});

function expectInOrder(source: string, expected: readonly string[]): void {
  let cursor = -1;
  for (const marker of expected) {
    const index = source.indexOf(marker, cursor + 1);
    expect(index, `Missing or reordered marker: ${marker}`).toBeGreaterThan(cursor);
    cursor = index;
  }
}
