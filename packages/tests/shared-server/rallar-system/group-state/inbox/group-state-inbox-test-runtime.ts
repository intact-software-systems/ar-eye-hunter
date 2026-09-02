import { Temporal } from '@js-temporal/polyfill';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { expect } from 'vitest';
import { createAppInboxTestDatabase, type AppInboxTestDatabase } from '../../app-inbox/test-support/app-inbox-test-database.ts';

import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';

import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';

import { requireGroupStateWritten } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result-codec.ts';

import type { GroupStateInboxDurableResult } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts';

import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';

import { AppInboxType, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import { type GroupStateService, type GroupStateWritten } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import type { GroupCreateAppInboxPayload } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { authSession } from '../group-state-test-runtime.ts';
import { TestResourceInbox, TestResourceInboxResults } from './group-state-inbox-resource-fixtures.ts';

export { TestResourceInbox, TestResourceInboxResults };

export const SCOPE: StateScope = {
    applicationId: 'ar-eye-hunter',
    workspaceId: 'default'
};

export interface AuthorityHarness {
    readonly nowEpochMs: number;
    readonly runtimeRepository: FakeRuntimeStateRepository;
    readonly repository: GroupStateRepository;
    readonly authSessions: AuthSessionRepository;
    readonly groupStateService: GroupStateService;
    readonly service: GroupStateInboxService;
    readonly database: AppInboxTestDatabase;
    readonly reader: InboxQueueReader;
    readonly queue: TestResourceInbox;
    readonly results: TestResourceInboxResults;
    readonly sessions: Readonly<Record<string, IssuedAuthSession>>;
    queueEntries(): Promise<readonly ResourceEntry[]>;
}
interface HarnessOptions {
    readonly wakeQueue?: () => void;
    readonly serviceOptions?: AppInboxOptions;
    /** The stored planned layout a fenced command reads, when a case needs one. */
    readonly readPlannedLayoutRow?: Parameters<typeof createGroupStateService>[0]['readPlannedLayoutRow'];
    /** Lets a case seed durable rows before the harness is constructed. */
    readonly runtimeRepository?: FakeRuntimeStateRepository;
}

export function listRoomEvents(harness: AuthorityHarness, groupId: string) {
    return harness.repository.listEvents({ ...SCOPE, groupId });
}

export async function createAuthorityHarness(
    principalIds: readonly string[],
    options: HarnessOptions = {}
): Promise<AuthorityHarness> {
    const nowEpochMs = Date.now();
    const runtimeRepository = options.runtimeRepository ?? new FakeRuntimeStateRepository();
    const authSessions = new AuthSessionRepository(runtimeRepository);
    const sessions = await createAuthoritySessions(principalIds, authSessions, nowEpochMs);
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
    const groupStateService = createGroupStateService({
        runtimeRepository,
        groupStateEventStore: database.groupEventStore,
        serviceId: 'server-12345678',
        readPlannedLayoutRow: options.readPlannedLayoutRow ?? (async () => null),
        readAcceptedLayoutRow: async () => null,
        now: () => nowEpochMs,
        authSessionRepository: authSessions
    });
    return {
        nowEpochMs,
        runtimeRepository,
        repository: createTestGroupStateRepository(runtimeRepository, database.groupEventStore),
        authSessions,
        groupStateService,
        service: createAuthorityAppInboxService({
            reader,
            queue,
            results,
            database,
            groupStateService,
            wakeQueue: options.wakeQueue,
            serviceOptions: options.serviceOptions
        }),
        database,
        reader,
        queue,
        results,
        sessions,
        queueEntries: async () => {
            const entries = await Promise.all(
                (await queue.getAllKeys()).map((key) => queue.getItem(key))
            );
            return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
        }
    };
}

async function createAuthoritySessions(
    principalIds: readonly string[],
    authSessions: AuthSessionRepository,
    nowEpochMs: number
): Promise<Readonly<Record<string, IssuedAuthSession>>> {
    const sessions = Object.fromEntries(
        principalIds.map((principalId) => [
            principalId,
            authSession({
                clientId: principalId,
                sessionId: `${principalId}-session`,
                accessToken: `${principalId}-token`,
                nowEpochMs
            })
        ])
    );
    for (const session of Object.values(sessions)) {
        await authSessions.putSession(session);
    }
    return sessions;
}

interface AuthorityAppInboxServiceInput {
    readonly reader: InboxQueueReader;
    readonly queue: TestResourceInbox;
    readonly results: TestResourceInboxResults;
    readonly database: AppInboxTestDatabase;
    readonly groupStateService: GroupStateService;
    readonly wakeQueue?: () => void;
    readonly serviceOptions?: AppInboxOptions;
}

function createAuthorityAppInboxService(
    input: AuthorityAppInboxServiceInput
): GroupStateInboxService {
    return new GroupStateInboxService(
        {
            inboxQueueReader: input.reader,
            resourceInboxRepository: input.queue,
            resourceInboxResultsRepository: input.results,
            database: input.database,
            groupStateService: input.groupStateService,
            resultReader: input.groupStateService
        },
        {
            serviceId: 'server-12345678',
            timing: undefined,
            options: input.serviceOptions,
            wakeOwningQueue: input.wakeQueue
        }
    );
}

export async function createRoom(
    harness: AuthorityHarness,
    groupId: string,
    displayName: string
): Promise<GroupStateWritten> {
    const owner = harness.sessions.owner;
    const created = await processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: owner,
        input: {
            type: AppInboxType.GROUP_CREATE,
            resourceId: `create-${groupId}`,
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
            senderId: owner.clientId,
            data: {
                scope: SCOPE,
                request: {
                    groupId,
                    displayName,
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: owner.clientId,
                    actorPrincipalId: owner.clientId,
                    actorSessionId: owner.sessionId,
                    requestId: `create-${groupId}`
                }
            }
        }
    });
    if (!created.right) {
        throw new Error('Expected authenticated group creation result');
    }
    const written = requireGroupStateWritten(created.right);
    expect(written.status).toBe('created');
    return written;
}

interface ProcessAuthenticatedInput {
    readonly service: GroupStateInboxService;
    readonly reader: InboxQueueReader;
    readonly authority: IssuedAuthSession;
    readonly input: AuthenticatedGroupMutationEnqueue;
}

export async function processAuthenticated(
    request: ProcessAuthenticatedInput
): ReturnType<GroupStateInboxService['processAuthenticatedGroupEntryUntilCompletion']> {
    const pending = request.service.processAuthenticatedGroupEntryUntilCompletion(
        request.input,
        request.authority
    );
    const outcome = await Promise.race([
        pending.then(
            () => 'settled' as const,
            () => 'settled' as const
        ),
        waitForQueueEntry(request.reader.inbox).then(() => 'queued' as const)
    ]);
    if (outcome === 'queued') {
        await request.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
    }
    return await pending;
}

export function requireGroupStateResult(
    result: Either<AppInboxFailure, GroupStateInboxDurableResult>
): GroupStateWritten {
    return result.fold((error) => {
        throw new Error(error.message);
    }, requireGroupStateWritten);
}

export async function waitForQueueEntry(
    queue: Pick<InMemoryQueueBox, 'getAllKeys' | 'getItem'>
): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const entries = await Promise.all((await queue.getAllKeys()).map((key) => queue.getItem(key)));
        if (entries.some((entry) => entry?.status === EntityStatus.NEW)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('Expected authenticated app inbox entry to be enqueued');
}

export function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1
    );
}
