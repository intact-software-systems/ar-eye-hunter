import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import type { ToAuthorisedWsClientConnectionInput } from '@shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts';
import type { ClientAuthorisedWsConnectReadInput } from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { createTestClientStateRepository, createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { putAuthorisedWsTestTicket } from '../../client-state/authorised-ws-test-ticket.ts';
import { TEST_DISCONNECTED_SESSION_RETENTION_MS } from '../../client-state/test-disconnected-session-retention.ts';
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
    /** Deletes the harness auth session, as a logout or an auth expiry does while its socket is still open. */
    revokeAuthSession(): Promise<void>;
    /** Starts an upgrade's connect with a fresh ticket; it waits for its result while the test drives the queue. */
    startAuthorisedWsConnect(input: ToAuthorisedWsClientConnectionInput): Promise<ResourceEntry>;
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
    const reader = new InboxQueueReader(queue, { newLaneConcurrency: 1 });
    const secondReader = new InboxQueueReader(queue, { newLaneConcurrency: 1 });
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
    const dependencies = { queue, results, database, clientState, groupState, authSessions };
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
        groups: createTestGroupStateRepository(runtimeRepository, database.groupEventStore),
        revokeAuthSession: async () => await authSessions.deleteSession(authSession),
        startAuthorisedWsConnect: async (input) => {
            const ticketDigest = await putAuthorisedWsTestTicket(authSessions, input.authSession, `${input.generationId}-ticket`);
            const queuedKeys = new Set((await queue.readEntries()).map((entry) => JSON.stringify(entry.key)));
            void client.writeAuthorisedWsClientConnect({ ...input, ticketDigest });
            return await waitForNewQueuedEntry(queue, queuedKeys);
        }
    };
}

async function waitForNewQueuedEntry(queue: TestResourceInbox, queuedKeys: ReadonlySet<string>): Promise<ResourceEntry> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const entry = (await queue.readEntries()).find((candidate) => !queuedKeys.has(JSON.stringify(candidate.key)));
        if (entry !== undefined) {
            return entry;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('The authorised connect was not queued');
}

interface WsCloseReaderDependencies {
    readonly queue: TestResourceInbox;
    readonly results: TestResourceInboxResults;
    readonly database: AppInboxTestDatabase;
    readonly clientState: ClientStateService;
    readonly groupState: GroupStateService;
    readonly authSessions: AuthSessionRepository;
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
            { serviceId: 'server-12345678', disconnectedSessionRetentionMs: TEST_DISCONNECTED_SESSION_RETENTION_MS }
        ),
        group: new GroupStateInboxService(
            {
                ...shared,
                groupStateService: dependencies.groupState,
                resultReader: {
                    readEvent: (ref, eventId) => dependencies.database.groupEventStore.readGroupEvent(ref, eventId)
                }
            },
            { serviceId: 'server-12345678' }
        )
    };
}

export function pauseNextLifecycleRead(
    state: Pick<GroupStateService, 'sessionGenerationLifecycle'>
): PausedLifecycleRead {
    const lifecycle = state.sessionGenerationLifecycle;
    const paused = pauseOnce();
    const originalRead = lifecycle.read.bind(lifecycle);
    lifecycle.read = async (identity) => await paused.after(await originalRead(identity));
    return paused;
}

/** Holds the next authorised connect after its one point read observed the ticket, the lifecycle and the client rows. */
export function pauseNextAuthorisedWsConnectRead(
    state: Pick<ClientStateService, 'readAuthorisedWsConnect'>
): PausedLifecycleRead {
    const paused = pauseOnce();
    const originalRead = state.readAuthorisedWsConnect.bind(state);
    Object.assign(state, {
        readAuthorisedWsConnect: async (input: ClientAuthorisedWsConnectReadInput) => await paused.after(await originalRead(input))
    });
    return paused;
}

function pauseOnce(): PausedLifecycleRead & Readonly<{ after<T>(read: T): Promise<T>; }> {
    const reached = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    let pause = true;
    return {
        reached: reached.promise,
        resume: resumed.resolve,
        after: async (read) => {
            if (pause) {
                pause = false;
                reached.resolve();
                await resumed.promise;
            }
            return read;
        }
    };
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
