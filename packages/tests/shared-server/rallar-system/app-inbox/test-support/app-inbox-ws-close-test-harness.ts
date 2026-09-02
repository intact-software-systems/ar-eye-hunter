import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { createTestClientStateRepository, createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { TestResourceInbox, TestResourceInboxResults } from './app-inbox-resource-fixtures.ts';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';

// Anchor the seed clock to the real processing clock. The AppInbox stamps and
// captures messages at Date.now(), so a fixed far-future base would make seeded
// connect/heartbeat timestamps read as future-dated relative to processing.
const NOW_EPOCH_MS = Date.now();
const SCOPE: StateScope = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

export interface AuthorisedWsCloseFacts {
    readonly authSession: IssuedAuthSession;
    readonly generationId: string;
    readonly input: Readonly<{
        applicationId: string;
        workspaceId: string;
        connectedAtEpochMs: number;
        expiresAtEpochMs: number;
    }>;
    readonly disconnectedAtEpochMs: number;
    readonly reason: string;
}

export interface AppInboxWsCloseHarness {
    readonly queue: TestResourceInbox;
    readonly reader: InboxQueueReader;
    readonly secondReader: InboxQueueReader;
    readonly authSession: IssuedAuthSession;
    readonly client: AppClientInboxService;
    readonly group: GroupStateInboxService;
    readonly clientState: ClientStateService;
    readonly groupState: GroupStateService;
    readonly clients: ClientStateRepository;
    readonly groups: GroupStateRepository;
}

interface CreateAppInboxWsCloseHarnessInput {
    readonly onRollback?: () => void;
    readonly onConditionalWrite?: (
        operation: 'insertIfAbsent' | 'upsertIfRevision' | 'deleteIfRevision',
        namespace: string,
        key: string
    ) => void;
}

interface AppInboxWsCloseState {
    readonly queue: TestResourceInbox;
    readonly results: TestResourceInboxResults;
    readonly runtimeRepository: FakeRuntimeStateRepository;
    readonly database: ReturnType<typeof createAppInboxTestDatabase>;
    readonly authSession: IssuedAuthSession;
    readonly clientState: ReturnType<typeof createClientStateService>;
    readonly groupState: ReturnType<typeof createGroupStateService>;
}

interface AppInboxWsCloseServiceRegistrationInput {
    readonly reader: InboxQueueReader;
    readonly state: AppInboxWsCloseState;
}

export function createAuthorisedWsCloseFacts(
    authSession: IssuedAuthSession,
    generationId: string,
    offset: number
): AuthorisedWsCloseFacts {
    const connectedAtEpochMs = NOW_EPOCH_MS - 1_000 + offset;
    return {
        authSession,
        generationId,
        input: {
            ...SCOPE,
            connectedAtEpochMs,
            expiresAtEpochMs: connectedAtEpochMs + 60_000
        },
        disconnectedAtEpochMs: connectedAtEpochMs + 1,
        reason: 'socket-closed'
    };
}

export async function createAppInboxWsCloseHarness(
    options: CreateAppInboxWsCloseHarnessInput = {}
): Promise<AppInboxWsCloseHarness> {
    const state = await createAppInboxWsCloseState(options);
    const reader = new InboxQueueReader(state.queue);
    const secondReader = new InboxQueueReader(state.queue);
    const services = createAppInboxWsCloseServices({ reader, state });
    createAppInboxWsCloseServices({ reader: secondReader, state });

    return {
        queue: state.queue,
        reader,
        secondReader,
        authSession: state.authSession,
        client: services.client,
        group: services.group,
        clientState: state.clientState,
        groupState: state.groupState,
        clients: createTestClientStateRepository(state.runtimeRepository),
        groups: createTestGroupStateRepository(state.runtimeRepository, state.database.groupEventStore)
    };
}

async function createAppInboxWsCloseState(
    options: CreateAppInboxWsCloseHarnessInput
): Promise<AppInboxWsCloseState> {
    const queue = new TestResourceInbox();
    const results = new TestResourceInboxResults();
    const runtimeRepository = new FakeRuntimeStateRepository();
    runtimeRepository.beforeConditionalWrite = options.onConditionalWrite;
    const database = createAppInboxTestDatabase(queue, results, {
        runtimeRepository,
        onTransactionRollback: options.onRollback
    });
    const authSessions = new AuthSessionRepository(runtimeRepository);
    const authSession = issuedSession('owner', 'owner-session');
    await authSessions.putSession(authSession);
    const groupState = createGroupStateService({
        runtimeRepository,
        authSessionRepository: authSessions,
        groupStateEventStore: database.groupEventStore,
        serviceId: 'server-12345678',
        readPlannedLayoutRow: async () => null,
        readAcceptedLayoutRow: async () => null,
        now: () => NOW_EPOCH_MS
    });
    const clientState = createClientStateService({
        runtimeRepository,
        clientStateEventStore: database.clientEventStore,
        serviceId: 'server-12345678'
    });
    return { queue, results, runtimeRepository, database, authSession, clientState, groupState };
}

function createAppInboxWsCloseServices(
    input: AppInboxWsCloseServiceRegistrationInput
): Readonly<{ client: AppClientInboxService; group: GroupStateInboxService; }> {
    const client = new AppClientInboxService(
        {
            inboxQueueReader: input.reader,
            resourceInboxRepository: input.state.queue,
            resourceInboxResultsRepository: input.state.results,
            database: input.state.database,
            clientStateService: input.state.clientState
        },
        {
            serviceId: 'server-12345678'
        }
    );
    const group = new GroupStateInboxService(
        {
            inboxQueueReader: input.reader,
            resourceInboxRepository: input.state.queue,
            resourceInboxResultsRepository: input.state.results,
            database: input.state.database,
            groupStateService: input.state.groupState,
            resultReader: input.state.groupState
        },
        {
            serviceId: 'server-12345678'
        }
    );
    return { client, group };
}

export function pauseNextLifecycleRead(
    state: Pick<ClientStateService | GroupStateService, 'sessionGenerationLifecycle'>
): Readonly<{ reached: Promise<void>; resume(): void; }> {
    const lifecycle = state.sessionGenerationLifecycle;
    const originalRead = lifecycle.read.bind(lifecycle);
    const reached = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    let pause = true;
    lifecycle.read = async (identity) => {
        const read = await originalRead(identity);
        if (pause) {
            pause = false;
            reached.resolve();
            await resumed.promise;
        }
        return read;
    };
    return { reached: reached.promise, resume: resumed.resolve };
}

function issuedSession(clientId: string, sessionId: string): IssuedAuthSession {
    return {
        clientId,
        sessionId,
        accessToken: `${clientId}-token`,
        username: clientId,
        issuedAtEpochMs: NOW_EPOCH_MS - 1_000,
        expiresAtEpochMs: NOW_EPOCH_MS + 60_000
    };
}
