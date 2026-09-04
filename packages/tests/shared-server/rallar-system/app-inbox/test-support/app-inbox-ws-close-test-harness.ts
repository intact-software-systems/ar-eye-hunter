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
import { createAppInboxTestDatabase, type AppInboxTestDatabase } from './app-inbox-test-database.ts';

// Anchor the seed clock to the real processing clock. The AppInbox stamps and
// captures messages at Date.now(), so a fixed far-future base would make seeded
// connect/heartbeat timestamps read as future-dated relative to processing.
const NOW_EPOCH_MS = Date.now();
const SCOPE: StateScope = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

interface AuthorisedWsConnectFacts extends StateScope {
    readonly connectedAtEpochMs: number;
    readonly expiresAtEpochMs: number;
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
interface AppInboxWsCloseHarnessOptions {
    readonly onRollback?: () => void;
    readonly onConditionalWrite?: FakeRuntimeStateRepository['beforeConditionalWrite'];
}
interface PausedLifecycleRead {
    readonly reached: Promise<void>;
    resume(): void;
}

export interface AuthorisedWsCloseFacts {
    readonly authSession: IssuedAuthSession;
    readonly generationId: string;
    readonly input: AuthorisedWsConnectFacts;
    readonly disconnectedAtEpochMs: number;
    readonly reason: string;
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
    options: AppInboxWsCloseHarnessOptions = {}
): Promise<AppInboxWsCloseHarness> {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const secondReader = new InboxQueueReader(queue);
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
    const dependencies = { queue, results, database, clientState, groupState };
    const { client, group } = installWsCloseReader(reader, dependencies);
    installWsCloseReader(secondReader, dependencies);
    return {
        queue,
        reader,
        secondReader,
        authSession,
        client,
        group,
        clientState,
        groupState,
        clients: createTestClientStateRepository(runtimeRepository),
        groups: createTestGroupStateRepository(runtimeRepository, database.groupEventStore)
    };
}

interface WsCloseReaderDependencies {
    readonly queue: TestResourceInbox;
    readonly results: TestResourceInboxResults;
    readonly database: AppInboxTestDatabase;
    readonly clientState: ClientStateService;
    readonly groupState: GroupStateService;
}

interface WsCloseReaderServices {
    readonly client: AppClientInboxService;
    readonly group: GroupStateInboxService;
}

function installWsCloseReader(
    reader: InboxQueueReader,
    dependencies: WsCloseReaderDependencies
): WsCloseReaderServices {
    const shared = {
        inboxQueueReader: reader,
        resourceInboxRepository: dependencies.queue,
        resourceInboxResultsRepository: dependencies.results,
        database: dependencies.database
    };
    return {
        client: new AppClientInboxService(
            { ...shared, clientStateService: dependencies.clientState },
            { serviceId: 'server-12345678' }
        ),
        group: new GroupStateInboxService(
            {
                ...shared,
                groupStateService: dependencies.groupState,
                resultReader: {
                    readSnapshot: (ref) => dependencies.groupState.readSnapshot(ref),
                    readEvent: (ref, eventId) => dependencies.database.groupEventStore.readGroupEvent(ref, eventId)
                }
            },
            { serviceId: 'server-12345678' }
        )
    };
}

export function pauseNextLifecycleRead(
    state: Pick<ClientStateService | GroupStateService, 'sessionGenerationLifecycle'>
): PausedLifecycleRead {
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
