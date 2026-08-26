import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { findMutationBoundaryViolations } from '../boundary/mutation-boundary-analysis.ts';
import { authoritativeMutationRuntimeSourcePaths } from './authoritative-mutation-runtime-source-inventory.ts';
import { readFunctionBody, readMethodBody } from './authoritative-mutation-source-analysis.ts';

// Retain permanently as cross-domain semantic phase-order evidence.
const read = (file: string): string => readFileSync(file, 'utf8');
const authRoot = 'packages/shared-server/rallar-system/auth';
const groupStateRoot = 'packages/shared-server/rallar-system/group-state';
const topologyInboxRoot = 'packages/shared-server/rallar-system/topology/inbox';
const topologyRoot = 'packages/shared-server/rallar-system/topology';
const adminInboxRoot = 'packages/shared-server/rallar-system/admin-operations/inbox';
const rtcInboxRoot = 'packages/shared-server/rallar-system/rtc-rtt/inbox';
const rtcMutationRoot = 'packages/shared-server/rallar-system/rtc-rtt/mutation';
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
    'nullablePositiveSafeInteger'
] as const;
const forbiddenPersistenceOwnerImport = new RegExp(
    String.raw`from ['"](?:\.\.\/)+` + String.raw`(?:mutation|services|inbox|repositories\/GroupStateRepository)(?:\/|\.ts)`
);

const sources = {
    appAdmin: read(`${adminInboxRoot}/app-admin-inbox-service.ts`),
    authHandler: read(`${authRoot}/inbox/auth-inbox-handler.ts`),
    appClient: read('packages/shared-server/rallar-system/client-state/inbox/client-state-inbox-handler.ts'),
    appCrdt: read('packages/shared-server/rallar-system/crdt/inbox/app-crdt-inbox-service.ts'),
    groupInbox: read(`${groupStateRoot}/inbox/group-state-inbox-service.ts`),
    topologyInbox: read(`${topologyInboxRoot}/topology-inbox-service.ts`),
    rtcInbox: read(`${rtcInboxRoot}/rtc-rtt-inbox-service.ts`),
    topologyHandler: read(`${topologyInboxRoot}/topology-app-inbox-handler.ts`),
    rtcHandler: read(`${rtcInboxRoot}/rtc-rtt-app-inbox-handler.ts`),
    groupHandler: read(`${groupStateRoot}/inbox/group-state-inbox-handler.ts`),
    groupService: read(`${groupStateRoot}/group-state-service.ts`),
    client: read('packages/shared-server/rallar-system/client-state/mutation/write/write-client-mutation.ts'),
    group: read(`${groupStateRoot}/mutation/write/write-group-mutation.ts`),
    topologyConfig: read(`${topologyRoot}/config/mutation/write-topology-config-mutation.ts`),
    topologyReconfigure: read(`${topologyRoot}/reconfigure/group-topology-reconfigure-mutation.ts`),
    topologyWorker: read(`${topologyRoot}/mutation/rtc-topology-outbox-work.ts`),
    topologyRepository: read(`${topologyRoot}/persistence/rtc-topology-execution-repository.ts`),
    rtt: read(`${rtcMutationRoot}/write-rtc-rtt-mutation.ts`)
};

const trackedRuntimeSource = authoritativeMutationRuntimeSourcePaths.map(read).join('\n');

const removedIntermediateOutboxSymbols = [
    'state-mutation:' + 'outbox',
    'StateMutation' + 'OutboxRepository',
    'StateMutation' + 'OutboxWork'
] as const;
it('contains no intermediate state-mutation outbox runtime wiring', () => {
    for (const forbidden of removedIntermediateOutboxSymbols) {
        expect(trackedRuntimeSource).not.toContain(forbidden);
    }
});

it('keeps group-state service and inbox ownership in the target modules', () => {
    for (
        const file of [
            `${groupStateRoot}/group-mutation-authority.ts`,
            `${groupStateRoot}/group-mutation-command.ts`,
            `${groupStateRoot}/group-presence-mutation-command.ts`,
            `${groupStateRoot}/group-state-service-contracts.ts`,
            `${groupStateRoot}/group-state-service.ts`,
            `${groupStateRoot}/inbox/group-state-inbox-contracts.ts`,
            `${groupStateRoot}/inbox/group-state-inbox-handler.ts`,
            `${groupStateRoot}/inbox/to-group-mutation-descriptor.ts`,
            `${groupStateRoot}/inbox/group-state-inbox-result.ts`
        ]
    ) {
        expect(existsSync(file), file).toBe(true);
    }
    expect(read(`${groupStateRoot}/group-state-service.ts`)).not.toContain('toDescriptorCommand(');
    expect(sources.groupHandler).toContain('export class GroupStateInboxHandler');
    expect(sources.groupService).not.toContain('../services/group-state-mutations.ts');
});

it('keeps persistence validators below mutation and stateful owners', () => {
    for (const file of [`${persistenceRoot}/validate-persisted-group.ts`, `${persistenceRoot}/validate-persisted-group-presence.ts`]) {
        const source = read(file);
        expect(source, file).not.toMatch(forbiddenPersistenceOwnerImport);
    }
});

it('keeps one implementation of each shared group-state validation primitive', () => {
    const validatorPaths = [`${persistenceRoot}/validate-persisted-group.ts`, `${persistenceRoot}/validate-persisted-group-presence.ts`];
    const ownerSources = [validationPrimitivesPath, oldValidationPath, ...validatorPaths].filter(existsSync).map(read).join('\n');

    for (const name of sharedValidationPrimitiveNames) {
        expect(ownerSources.match(new RegExp(`function\\s+${name}\\s*\\(`, 'g')) ?? [], name).toHaveLength(1);
    }
});

it('keeps shared validation primitives in the feature root', () => {
    expect(existsSync(validationPrimitivesPath), validationPrimitivesPath).toBe(true);
    expect(existsSync(oldValidationPath), oldValidationPath).toBe(false);

    for (const file of [`${persistenceRoot}/validate-persisted-group.ts`, `${persistenceRoot}/validate-persisted-group-presence.ts`]) {
        expect(read(file), file).toContain('from \'../group-state-validation-primitives.ts\'');
    }
});

it.each([
    {
        name: 'auth AppInbox',
        source: sources.authHandler,
        owner: 'processAuthMutation',
        calls: [
            'materializeAuthMutationIntent(intent,',
            'this.dependencies.mutationService.read(command)',
            'this.dependencies.mutationService.compute(command, read, materialized.facts)',
            'this.dependencies.mutationService.validate(command, read, computed)',
            'this.dependencies.transactionWriter.writeMutation(',
            'this.dependencies.mutationService.write(transaction, computed)'
        ]
    },
    {
        name: 'CRDT AppInbox',
        source: sources.appCrdt,
        owner: 'processCommand',
        calls: [
            'this.mutationService.read(command)',
            'this.mutationService.compute({ command, read })',
            'this.mutationService.validate({ command, read, computed })',
            'this.mutationService.write(transaction, computed)'
        ]
    },
    {
        name: 'admin AppInbox',
        source: sources.appAdmin,
        owner: 'processCommand',
        calls: [
            'this.read(command)',
            'this.compute(read)',
            'this.validate(computed)',
            'this.handlers.writeMutation(context'
        ]
    },
    {
        name: 'client AppInbox',
        source: sources.appClient,
        owner: 'processCommand',
        calls: [
            'this.dependencies.mutationService.read(command)',
            'this.dependencies.mutationService.compute(command, read)',
            'this.dependencies.mutationService.validate(command, read, computed)',
            'this.commitComputed(context, computed)'
        ]
    },
    {
        name: 'group AppInbox',
        source: sources.groupHandler,
        owner: 'processGroupStateMutation',
        calls: [
            'this.dependencies.mutationService.read(command)',
            'this.dependencies.mutationService.compute(command, read)',
            'this.dependencies.mutationService.validate(command, read, computed)',
            'this.commitMutation({ context, command, computed })'
        ]
    },
    {
        name: 'topology config AppInbox',
        source: sources.topologyHandler,
        owner: 'processMutation',
        calls: [
            'owners.configMutationService.read(',
            'owners.configMutationService.compute(',
            'owners.configMutationService.validate(',
            'this.dependencies.transactionWriter.writeMutation(',
            'owners.configMutationService.write('
        ]
    },
    {
        name: 'topology reconfigure AppInbox',
        source: sources.topologyHandler,
        owner: 'processTopologyReconfigureMutation',
        calls: [
            'mutation.read(command)',
            'mutation.compute(command, read)',
            'mutation.validate(command, read, computed)',
            'this.dependencies.transactionWriter.writeMutation(',
            'mutation.write(transaction, computed)'
        ]
    },
    {
        name: 'RTC RTT AppInbox',
        source: sources.rtcHandler,
        owner: 'processMutation',
        calls: ['readRtcRttMutation(', 'computeRtcRttMutation(', 'validateRtcRttMutation(', 'this.commitMutation(']
    }
])('$name keeps one visible read/compute/validate/write path', ({ source, owner, calls }) => {
    const body = readMethodBody(source, owner);
    expectInOrder(body, calls);
});

it('keeps every authoritative service write bound to the caller transaction', () => {
    expect(sources.topologyConfig).toMatch(/readonly transaction:\s*PSqlSql/);
    expect(sources.rtt).toMatch(/readonly transaction:\s*PSqlSql/);
    const positionalTransactionSeams = [
        readFunctionBody(sources.client, 'writeClientMutation'),
        readFunctionBody(sources.group, 'writeGroupMutation'),
        readMethodBody(sources.topologyReconfigure, 'write'),
        readMethodBody(sources.topologyRepository, 'writeTopologyMutation')
    ];
    for (const seam of positionalTransactionSeams) {
        expect(seam).toMatch(/transaction:\s*PSqlSql/);
    }
    for (
        const seam of [
            ...positionalTransactionSeams,
            readFunctionBody(sources.topologyConfig, 'writeTopologyConfigMutation'),
            readFunctionBody(sources.rtt, 'writeRtcRttMutation')
        ]
    ) {
        expect(seam).not.toMatch(/\.begin\s*\(/);
        expect(seam).not.toMatch(/waitForRuntimeStateWriteRetry/);
    }
});

it('keeps AppInbox as the only retry and transaction owner for HTTP and WS mutations', () => {
    for (
        const source of [
            sources.topologyConfig,
            sources.topologyReconfigure,
            sources.topologyRepository,
            sources.rtt,
            sources.topologyWorker
        ]
    ) {
        expect(source).not.toMatch(/waitForRuntimeStateWriteRetry/);
        expect(source).not.toMatch(/for\s*\([^)]*attempt/);
    }
    expect(sources.topologyHandler).toContain('this.dependencies.transactionWriter.writeMutation(');
    expect(sources.rtcHandler).toContain('this.dependencies.writeMutation(');
    expect(sources.rtcInbox).toContain('AppInboxType.RTC_RTT_SUBMIT');
    expect(sources.topologyInbox).toContain('AppInboxType.TOPOLOGY_RECONFIGURE');
});

it('keeps transport boundaries free of direct mutators and persistence owners', () => {
    expect(findMutationBoundaryViolations()).toEqual([]);
}, 15_000);

it('writes topology config state, receipt, authority fence, and APP_OUTBOX atomically', () => {
    const seam = readFunctionBody(sources.topologyConfig, 'writeTopologyConfigMutation');
    expectInOrder(seam, [
        'writeTopologyConfigAuthorityFence(',
        'writeTopologyConfigState(',
        'insertMutationRecord(',
        'input.outboxWriter.write(transaction, computed.outbox)'
    ]);
    expectInOrder(readFunctionBody(sources.topologyConfig, 'writeTopologyConfigAuthorityFence'), [
        'advanceGroupStateAuthorityFence(',
        'computed.groupAuthorityGuard',
        'throw new RuntimeStateWriteConflictError()'
    ]);
    expect(seam).not.toContain('StateMutation' + 'Outbox');
});

it('fences explicit reconfigure authority before inserting APP_OUTBOX', () => {
    const seam = readMethodBody(sources.topologyReconfigure, 'write');
    expectInOrder(seam, [
        'advanceGroupStateAuthorityFence(',
        'computed.authorityGuard',
        'throw new RuntimeStateWriteConflictError()',
        'this.dependencies.outboxWriter.write(transaction, computed)'
    ]);
});

it('writes RTT admission, measurement, receipt, and direct APP_OUTBOX rows atomically', () => {
    const seam = readFunctionBody(sources.rtt, 'writeRtcRttMutation');
    expectInOrder(seam, [
        'commitEndpointAdmission(',
        'commitMeasurement(',
        'insertMutationReceipt(',
        'input.outboxWriter.write(transaction,'
    ]);
    expect(seam).not.toContain('insertRecomputeIntent');
    expect(seam).not.toContain('StateMutation' + 'Outbox');
});

it('keeps all topology and RTT computed effects direct and mandatory', () => {
    const topologyEntry = read(`${topologyRoot}/mutation/rtc-topology-outbox-entry.ts`);
    const topologyWsEntry = read(`${topologyRoot}/publication/rtc-topology-ws-outbox-entry.ts`);
    for (
        const field of [
            'commandId',
            'resourceId',
            'aggregateRef',
            'acceptedCausalRevision',
            'groupSnapshot',
            'createdAtEpochMs',
            'expireAtEpochMs',
            'senderId',
            'requestOptions',
            'publish'
        ]
    ) {
        expect(topologyEntry).toMatch(new RegExp(`readonly\\s+${field}(?!\\?)`));
    }
    expect(topologyWsEntry).toContain('EnqueuedType.WS_OUTBOX');
    expect(topologyEntry).toContain('EnqueuedType.APP_OUTBOX');
});

it('does not reintroduce intermediate state-mutation intents on authoritative paths', () => {
    for (
        const source of [
            sources.groupInbox,
            sources.topologyInbox,
            sources.rtcInbox,
            sources.topologyConfig,
            sources.topologyReconfigure,
            sources.rtt,
            sources.topologyWorker
        ]
    ) {
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
