import { Temporal } from '@js-temporal/polyfill';

import { decodeAppInboxEnqueue } from '@shared-server/rallar-system/app-inbox/app-inbox-command-decoding.ts';
import { AppInboxType, type AppInboxMessageContext } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { encodeAppInboxResult } from '@shared-server/rallar-system/app-inbox/app-inbox-registration-codecs.ts';
import { GROUP_STATE_APP_INBOX_TOPIC } from '@shared-server/rallar-system/app-inbox/app-inbox-topics.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupMutationPreparation, GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateInboxHandler } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts';
import type { GroupStateInboxDurableResult } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type { GroupFormationGroupMutationEvent } from '@shared-server/rallar-system/observability/formation-metrics.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { CreateGroupRequest, StateScope } from '@shared/api/state-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import {
    createAppInboxTestDatabase,
    type AppInboxTestDatabase,
    type AppInboxTestDatabaseStage
} from '../../app-inbox/test-support/app-inbox-test-database.ts';
import { authSession } from '../group-state-test-runtime.ts';
import { TestResourceInbox, TestResourceInboxResults } from './group-state-inbox-resource-fixtures.ts';

const NOW_EPOCH_MS = Date.parse('2026-08-02T00:00:00.000Z');
const GROUP_ID = 'transaction-boundary-room';
const REQUEST_ID = 'create-transaction-boundary-room';
const SCOPE: StateScope = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

export type GroupTransactionFailurePhase = 'domain-write' | AppInboxTestDatabaseStage;

export interface GroupStateTransactionBoundaryHarness {
    readonly context: AppInboxMessageContext<GroupStateInboxDurableResult>;
    readonly handler: GroupStateInboxHandler;
    readonly queue: TestResourceInbox;
    readonly results: TestResourceInboxResults;
    readonly repository: GroupStateRepository;
    readonly outboxEntries: ReadonlyMap<string, ResourceEntry>;
    readonly reachedStages: readonly string[];
    readonly observedSnapshots: readonly GroupSnapshot[];
    readonly formationMutationEvents: readonly GroupFormationGroupMutationEvent[];
    readonly transactionWriter: AppInboxTransactionWriter;
    readonly groupRef: GroupRef;
    readWakeCount(): number;
}

interface TransactionBoundaryStorage {
    readonly runtimeRepository: FakeRuntimeStateRepository;
    readonly queue: TestResourceInbox;
    readonly results: TestResourceInboxResults;
    readonly database: AppInboxTestDatabase;
    readonly reachedStages: string[];
    enableFailures(): void;
}

interface TransactionBoundaryGroupStateOwner {
    readonly service: GroupStateService;
    readonly observedSnapshots: GroupSnapshot[];
}

export async function createGroupStateTransactionBoundaryHarness(
    failurePhase?: GroupTransactionFailurePhase
): Promise<GroupStateTransactionBoundaryHarness> {
    const storage = createTransactionBoundaryStorage(failurePhase);
    const groupState = await createTransactionBoundaryGroupStateService(storage);
    const prepared = await groupState.service.prepareMutation(
        mutationDescriptor({ operation: 'createGroup', scope: SCOPE, groupId: GROUP_ID, request: createGroupRequest() }),
        createOwnerAuthority()
    );
    const context = await createReservedContext(storage.queue, prepared);
    const execution = createTransactionBoundaryExecution(storage, groupState);
    execution.transactionWriter.begin(context);
    return {
        context,
        ...execution,
        queue: storage.queue,
        results: storage.results,
        repository: createTestGroupStateRepository(
            storage.runtimeRepository,
            storage.database.groupEventStore
        ),
        outboxEntries: storage.database.outboxEntries,
        reachedStages: storage.reachedStages,
        observedSnapshots: groupState.observedSnapshots,
        groupRef: { ...SCOPE, groupId: GROUP_ID }
    };
}

export async function createReconfigureGroupStateTransactionBoundaryHarness(
    failurePhase: GroupTransactionFailurePhase
): Promise<GroupStateTransactionBoundaryHarness> {
    const storage = createTransactionBoundaryStorage(failurePhase, false);
    const groupState = await createTransactionBoundaryGroupStateService(storage);
    const execution = createTransactionBoundaryExecution(storage, groupState);
    const { handler, transactionWriter } = execution;
    const seedPrepared = await groupState.service.prepareMutation(
        mutationDescriptor({
            operation: 'createGroup',
            scope: SCOPE,
            groupId: GROUP_ID,
            request: createHoldLandingGroupRequest()
        }),
        createOwnerAuthority()
    );
    const seedContext = await createReservedContext(storage.queue, seedPrepared);
    transactionWriter.begin(seedContext);
    await handler.processGroupStateMutation(seedContext);
    storage.reachedStages.length = 0;

    const prepared = await groupState.service.prepareMutation(
        mutationDescriptor({
            operation: 'reconfigureGroup',
            scope: SCOPE,
            groupId: GROUP_ID,
            request: reconfigureGroupRequest()
        }),
        createOwnerAuthority()
    );
    const context = await createReconfigureReservedContext(storage.queue, prepared);
    transactionWriter.begin(context);
    storage.enableFailures();
    return {
        context,
        ...execution,
        queue: storage.queue,
        results: storage.results,
        repository: createTestGroupStateRepository(storage.runtimeRepository, storage.database.groupEventStore),
        outboxEntries: storage.database.outboxEntries,
        reachedStages: storage.reachedStages,
        observedSnapshots: groupState.observedSnapshots,
        groupRef: { ...SCOPE, groupId: GROUP_ID }
    };
}

interface TransactionBoundaryExecution {
    readonly handler: GroupStateInboxHandler;
    readonly transactionWriter: AppInboxTransactionWriter;
    readonly formationMutationEvents: readonly GroupFormationGroupMutationEvent[];
    readWakeCount(): number;
}

function createTransactionBoundaryExecution(
    storage: TransactionBoundaryStorage,
    groupState: TransactionBoundaryGroupStateOwner
): TransactionBoundaryExecution {
    let wakeCount = 0;
    const transactionWriter = new AppInboxTransactionWriter(
        { database: storage.database },
        {
            serviceId: 'server-12345678',
            nowEpochMs: () => NOW_EPOCH_MS
        }
    );
    const formationMutationEvents: GroupFormationGroupMutationEvent[] = [];
    const handler = new GroupStateInboxHandler({
        mutationService: groupState.service,
        readAuthenticatedMutation: async () => {
            throw new Error('A reserved transaction-boundary command must already be internal.');
        },
        sessionGenerationLifecycle: groupState.service.sessionGenerationLifecycle,
        resultReader: createTestGroupStateRepository(
            storage.runtimeRepository,
            storage.database.groupEventStore
        ),
        transactionWriter,
        wakeQueue: () => {
            wakeCount += 1;
        },
        formationMetrics: (event) => {
            formationMutationEvents.push(event);
        }
    });
    return { handler, transactionWriter, formationMutationEvents, readWakeCount: () => wakeCount };
}

function createTransactionBoundaryStorage(
    failurePhase?: GroupTransactionFailurePhase,
    failuresEnabled = true
): TransactionBoundaryStorage {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const queue = new TestResourceInbox();
    const results = new TestResourceInboxResults();
    const reachedStages: string[] = [];
    const database = createAppInboxTestDatabase(queue, results, {
        runtimeRepository,
        onStage: async (stage) => {
            reachedStages.push(stage);
            if (failuresEnabled && stage === failurePhase) {
                throw new Error(`controlled ${stage} failure`);
            }
        }
    });
    if (failurePhase === 'domain-write') {
        runtimeRepository.beforeConditionalWrite = () => {
            reachedStages.push('domain-write');
            if (failuresEnabled) {
                throw new Error('controlled domain-write failure');
            }
        };
    }
    return {
        runtimeRepository,
        queue,
        results,
        database,
        reachedStages,
        enableFailures: () => {
            failuresEnabled = true;
        }
    };
}

async function createTransactionBoundaryGroupStateService(
    storage: TransactionBoundaryStorage
): Promise<TransactionBoundaryGroupStateOwner> {
    const authSessions = new AuthSessionRepository(storage.runtimeRepository);
    const authority = createOwnerAuthority();
    await authSessions.putSession(authority);
    const groupStateService = createGroupStateService({
        runtimeRepository: storage.runtimeRepository,
        groupStateEventStore: storage.database.groupEventStore,
        serviceId: 'server-12345678',
        readPlannedLayoutRow: async () => null,
        readAcceptedLayoutRow: async () => null,
        now: () => NOW_EPOCH_MS,
        randomId: () => 'fixed-random-id',
        authSessionRepository: authSessions
    });
    const observedSnapshots: GroupSnapshot[] = [];
    const service: GroupStateService = {
        ...groupStateService,
        observeSnapshot: (snapshot: GroupSnapshot) => {
            observedSnapshots.push(snapshot);
            return Promise.resolve(snapshot);
        }
    };
    return { service, observedSnapshots };
}

function createOwnerAuthority(): IssuedAuthSession {
    return {
        ...authSession({
            clientId: 'owner',
            sessionId: 'owner-session',
            accessToken: 'owner-token',
            nowEpochMs: NOW_EPOCH_MS
        }),
        expiresAtEpochMs: 253_402_300_799_999
    };
}

function createGroupRequest(): CreateGroupRequest {
    return {
        groupId: GROUP_ID,
        displayName: 'Transaction boundary room',
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'owner',
        actorPrincipalId: 'owner',
        actorSessionId: 'owner-session',
        requestId: REQUEST_ID
    };
}

function createHoldLandingGroupRequest(): CreateGroupRequest {
    return {
        ...createGroupRequest(),
        lifecyclePolicy: { topology: { reconfigureLanding: 'hold' } }
    };
}

interface ReconfigureBoundaryRequest {
    readonly actorPrincipalId: string;
    readonly actorSessionId: string;
    readonly expectedFormationEpoch: number;
    readonly landing: null;
    readonly requestId: string;
}

function reconfigureGroupRequest(): ReconfigureBoundaryRequest {
    return {
        actorPrincipalId: 'owner',
        actorSessionId: 'owner-session',
        expectedFormationEpoch: 0,
        landing: null,
        requestId: 'reconfigure-transaction-boundary-room'
    };
}

async function createReservedContext(
    queue: TestResourceInbox,
    authority: GroupMutationPreparation
): Promise<AppInboxMessageContext<GroupStateInboxDurableResult>> {
    const enqueue = decodeAppInboxEnqueue({
        type: AppInboxType.GROUP_CREATE,
        resourceId: REQUEST_ID,
        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${GROUP_ID}`,
        authority,
        data: { scope: SCOPE, request: createGroupRequest() }
    });
    const createdAt = Temporal.Instant.fromEpochMilliseconds(NOW_EPOCH_MS);
    const entry: ResourceEntry = {
        key: {
            topicId: GROUP_STATE_APP_INBOX_TOPIC,
            resourceId: REQUEST_ID,
            contextId: requireContextId(enqueue.contextId)
        },
        resource: JSON.stringify(enqueue),
        typeId: AppInboxType.GROUP_CREATE,
        status: EntityStatus.RESERVED,
        audit: {
            date: createdAt.toZonedDateTimeISO('UTC').toPlainTime(),
            createdBy: 'owner',
            createdTs: createdAt.toZonedDateTimeISO('UTC').toPlainDateTime(),
            expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.999Z')
        },
        dequeueAudit: { attempts: 1, startTs: createdAt }
    };
    await queue.enqueue(entry);
    return {
        enqueue,
        entry,
        message: newALUntargetedMessage(
            'owner',
            newALRoute(entry.key.topicId, entry.key.contextId, entry.key.resourceId),
            enqueue.type,
            enqueue
        ),
        encodeResult: (result) => encodeAppInboxResult(result, 'Group transaction test result')
    };
}

async function createReconfigureReservedContext(
    queue: TestResourceInbox,
    authority: GroupMutationPreparation
): Promise<AppInboxMessageContext<GroupStateInboxDurableResult>> {
    const enqueue = decodeAppInboxEnqueue({
        type: AppInboxType.GROUP_RECONFIGURE,
        resourceId: 'reconfigure-transaction-boundary-room',
        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${GROUP_ID}:reconfigure`,
        authority,
        data: { scope: SCOPE, groupId: GROUP_ID, request: reconfigureGroupRequest() }
    });
    const createdAt = Temporal.Instant.fromEpochMilliseconds(NOW_EPOCH_MS);
    const entry: ResourceEntry = {
        key: {
            topicId: GROUP_STATE_APP_INBOX_TOPIC,
            resourceId: 'reconfigure-transaction-boundary-room',
            contextId: requireContextId(enqueue.contextId)
        },
        resource: JSON.stringify(enqueue),
        typeId: AppInboxType.GROUP_RECONFIGURE,
        status: EntityStatus.RESERVED,
        audit: {
            date: createdAt.toZonedDateTimeISO('UTC').toPlainTime(),
            createdBy: 'owner',
            createdTs: createdAt.toZonedDateTimeISO('UTC').toPlainDateTime(),
            expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.999Z')
        },
        dequeueAudit: { attempts: 1, startTs: createdAt }
    };
    await queue.enqueue(entry);
    return {
        enqueue,
        entry,
        message: newALUntargetedMessage(
            'owner',
            newALRoute(entry.key.topicId, entry.key.contextId, entry.key.resourceId),
            enqueue.type,
            enqueue
        ),
        encodeResult: (result) => encodeAppInboxResult(result, 'Group transaction test result')
    };
}

function requireContextId(value: string | undefined): string {
    if (value === undefined || value.length === 0) {
        throw new TypeError('Group transaction contextId is required');
    }
    return value;
}
