import { Temporal } from '@js-temporal/polyfill';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';

import { decodeAppInboxEnqueue } from '@shared-server/rallar-system/app-inbox/app-inbox-command-decoding.ts';
import { AppInboxType, type AppInboxExecutionMetadata } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { GROUP_STATE_APP_INBOX_TOPIC } from '@shared-server/rallar-system/app-inbox/app-inbox-topics.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupMutationPreparation, GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateInboxHandler } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { CreateGroupRequest } from '@shared/api/state-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAppInboxTestDatabase, type AppInboxTestDatabaseStage } from '../../app-inbox/test-support/app-inbox-test-database.ts';
import { authSession } from '../group-state-test-runtime.ts';
import { TestResourceInbox, TestResourceInboxResults } from './group-state-inbox-resource-fixtures.ts';

const NOW_EPOCH_MS = Date.parse('2026-08-02T00:00:00.000Z');
const GROUP_ID = 'transaction-boundary-room';
const REQUEST_ID = 'create-transaction-boundary-room';
const SCOPE = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

export type GroupTransactionFailurePhase = 'domain-write' | AppInboxTestDatabaseStage;

export interface GroupStateTransactionBoundaryHarness {
    readonly context: AppInboxExecutionMetadata;
    readonly handler: GroupStateInboxHandler;
    readonly queue: TestResourceInbox;
    readonly results: TestResourceInboxResults;
    readonly repository: GroupStateRepository;
    readonly outboxEntries: ReadonlyMap<string, ResourceEntry>;
    readonly reachedStages: readonly string[];
    readonly observedSnapshots: readonly GroupSnapshot[];
    readonly formationMutationEvents: readonly Readonly<{
        operation: string;
        outcome: string;
    }>[];
    readonly transactionWriter: AppInboxTransactionWriter;
    readonly groupRef: typeof SCOPE & Readonly<{ groupId: string; }>;
    readWakeCount(): number;
}

interface TransactionBoundaryStorage {
    readonly runtimeRepository: FakeRuntimeStateRepository;
    readonly queue: TestResourceInbox;
    readonly results: TestResourceInboxResults;
    readonly database: ReturnType<typeof createAppInboxTestDatabase>;
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
    const owner = createTransactionBoundaryHandler(storage, groupState.service);
    owner.transactionWriter.begin(context);
    return {
        ...owner,
        context,
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
    const owner = createTransactionBoundaryHandler(storage, groupState.service);
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
    owner.transactionWriter.begin(seedContext);
    await owner.handler.processGroupStateMutation(seedContext);
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
    owner.transactionWriter.begin(context);
    storage.enableFailures();
    return {
        ...owner,
        context,
        queue: storage.queue,
        results: storage.results,
        repository: createTestGroupStateRepository(storage.runtimeRepository, storage.database.groupEventStore),
        outboxEntries: storage.database.outboxEntries,
        reachedStages: storage.reachedStages,
        observedSnapshots: groupState.observedSnapshots,
        groupRef: { ...SCOPE, groupId: GROUP_ID }
    };
}

function createTransactionBoundaryHandler(
    storage: TransactionBoundaryStorage,
    service: GroupStateService
): Pick<GroupStateTransactionBoundaryHarness, 'handler' | 'transactionWriter' | 'formationMutationEvents' | 'readWakeCount'> {
    let wakeCount = 0;
    const transactionWriter = new AppInboxTransactionWriter(
        { database: storage.database },
        { serviceId: 'server-12345678', nowEpochMs: () => NOW_EPOCH_MS }
    );
    const formationMutationEvents: Array<Readonly<{ operation: string; outcome: string; }>> = [];
    const handler = new GroupStateInboxHandler({
        mutationService: service,
        resultReader: service,
        prepareMutation: service.prepareMutation,
        persistPreparation: async () => {
            throw new Error('A reserved transaction-boundary command must already be prepared.');
        },
        sessionGenerationLifecycle: service.sessionGenerationLifecycle,
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
        kind: 'room' as const,
        joinMode: 'open' as const,
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

function reconfigureGroupRequest() {
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
): Promise<AppInboxExecutionMetadata> {
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
        message: {} as never
    };
}

async function createReconfigureReservedContext(
    queue: TestResourceInbox,
    authority: GroupMutationPreparation
): Promise<AppInboxExecutionMetadata> {
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
        message: {} as never
    };
}

function requireContextId(value: string | undefined): string {
    if (value === undefined || value.length === 0) {
        throw new TypeError('Group transaction contextId is required');
    }
    return value;
}
