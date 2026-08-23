import { Temporal } from '@js-temporal/polyfill';
import { vi } from 'vitest';

import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';
import {
    type ClientMutationWritten,
    type ClientStateService,
    type ClientStateWritten
} from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { toAuthenticatedClientMutationContextId } from '@shared-server/rallar-system/client-state/inbox/authenticated-client-mutation-ingress.ts';
import type { ClientStateEventStore } from '@shared-server/rallar-system/state-events/client-state-event-store.ts';

import { createWsSessionGenerationLifecycleService } from '@shared-server/rallar-system/websocket/ws-session-generation-lifecycle.ts';

import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import { TestResourceInbox, TestResourceInboxResults } from './app-client-inbox-resource-fixtures.ts';

export const CLIENT_STATE_TEST_SCOPE: StateScope = {
    applicationId: 'ar-eye-hunter',
    workspaceId: 'default'
};
const TEST_AUTHORITIES = new WeakMap<AppClientInboxService, Map<string, IssuedAuthSession>>();

export function requireRightSnapshot(
    result: Either<AppInboxFailure, ClientStateWritten>
): ClientSnapshot {
    if (!result.right) {
        throw new Error(result.left?.message ?? 'Expected client app-inbox right result');
    }

    return requireClientStateWrittenSnapshot(result.right);
}

export function requireRightWritten(
    result: Either<AppInboxFailure, ClientStateWritten>
): ClientMutationWritten {
    if (!result.right) {
        throw new Error(result.left?.message ?? 'Expected client app-inbox right result');
    }

    return requireClientMutationWritten(result.right);
}

function requireClientStateWrittenSnapshot(written: ClientStateWritten): ClientSnapshot {
    return requireClientMutationWritten(written).snapshot;
}

function requireClientMutationWritten(written: ClientStateWritten): ClientMutationWritten {
    return written.result;
}

export async function processAppInbox<V>(
    service: AppClientInboxService,
    reader: InboxQueueReader,
    input: {
        type: AppInboxType;
        topicId?: string;
        resourceId?: string;
        contextId?: string;
        senderId?: string;
        data: V;
    }
): Promise<Either<AppInboxFailure, ClientStateWritten>> {
    const authority = toTestIssuedAuthority(service, input);
    const resultPromise = service.processAuthenticatedEntryUntilCompletion(
        toAuthenticatedClientTestEnqueue(input, authority),
        authority
    );
    await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

    return await resultPromise;
}

function toTestIssuedAuthority<V>(
    service: AppClientInboxService,
    input: Readonly<{
        senderId?: string;
        data: V;
    }>
): IssuedAuthSession {
    const data = typeof input.data === 'object' && input.data !== null
        ? Object.fromEntries(Object.entries(input.data))
        : {};
    const request = typeof data.request === 'object' && data.request !== null
        ? Object.fromEntries(Object.entries(data.request))
        : {};
    const principalId = typeof data.principalId === 'string'
        ? data.principalId
        : (input.senderId ?? 'alice');
    const sessionId = typeof data.sessionId === 'string'
        ? data.sessionId
        : typeof request.actorSessionId === 'string'
        ? request.actorSessionId
        : `${principalId}-test-authority-session`;
    let authorities = TEST_AUTHORITIES.get(service);
    if (!authorities) {
        authorities = new Map();
        TEST_AUTHORITIES.set(service, authorities);
    }
    const key = `${principalId}:${sessionId}`;
    const existing = authorities.get(key);
    if (existing) {
        return existing;
    }
    const created = issuedSession(principalId, sessionId);
    authorities.set(key, created);
    return created;
}

export async function processAuthenticatedClientMutation<V>(
    service: AppClientInboxService,
    input: {
        type: AppInboxType;
        topicId?: string;
        resourceId?: string;
        contextId?: string;
        senderId?: string;
        data: V;
    },
    authority: IssuedAuthSession
): Promise<Either<AppInboxFailure, ClientStateWritten>> {
    return await service.processAuthenticatedEntryUntilCompletion(
        toAuthenticatedClientTestEnqueue(input, authority),
        authority
    );
}

function toAuthenticatedClientTestEnqueue<V>(
    input: Readonly<{
        type: AppInboxType;
        topicId?: string;
        resourceId?: string;
        contextId?: string;
        senderId?: string;
        data: V;
    }>,
    authority: IssuedAuthSession
) {
    const data = input.data as
        & V
        & Readonly<{
            scope: StateScope;
            principalId: string;
            request: Readonly<{ requestId: string; }>;
        }>;
    return {
        ...input,
        topicId: input.type,
        resourceId: data.request.requestId,
        contextId: toAuthenticatedClientMutationContextId({
            scope: data.scope,
            principalId: data.principalId,
            callerClientId: authority.clientId,
            callerSessionId: authority.sessionId
        })
    };
}

export function issuedSession(clientId: string, sessionId: string): IssuedAuthSession {
    const nowEpochMs = Date.now();
    return {
        clientId,
        accessToken: `${clientId}-token`,
        username: clientId,
        sessionId,
        issuedAtEpochMs: nowEpochMs - 1_000,
        expiresAtEpochMs: nowEpochMs + 60_000
    };
}

async function waitForQueueEntryStatus(
    queue: InMemoryQueueBox,
    status: EntityStatus
): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
        if ((await readEntries(queue)).some((entry) => entry.status === status)) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    throw new Error(`Expected app inbox entry with status ${status}`);
}

export async function readEntries(queue: InMemoryQueueBox): Promise<ResourceEntry[]> {
    const entries = await Promise.all((await queue.getAllKeys()).map((key) => queue.getItem(key)));

    return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
}

export function createClientStateServiceStub(
    overrides: Partial<ClientStateService> = {}
): ClientStateService {
    return {
        sessionGenerationLifecycle: createWsSessionGenerationLifecycleService(
            new FakeRuntimeStateRepository()
        ),
        listSnapshots: vi.fn(),
        readSnapshot: vi.fn(),
        readPresenceSnapshot: vi.fn(),
        listEvents: vi.fn(),
        listRecentEvents: vi.fn(),
        listEventPage: vi.fn(),
        read: vi.fn(),
        compute: vi.fn(),
        validate: vi.fn(),
        write: vi.fn(),
        listExpiredSessionCandidates: vi.fn(async () => []),
        findSessionBySessionId: vi.fn(),
        readIssuedAuthSession: vi.fn(),
        observeSnapshot: vi.fn(async (snapshot) => snapshot),
        ...overrides
    };
}

export function createAutoAuthorizingClientStateService(
    runtimeRepository: FakeRuntimeStateRepository,
    database: ReturnType<typeof createAppInboxTestDatabase>,
    eventStore: ClientStateEventStore = database.clientEventStore
): ClientStateService {
    const authSessions = new AuthSessionRepository(runtimeRepository);
    const durable = createClientStateService({
        runtimeRepository,
        clientStateEventStore: eventStore,
        serviceId: 'server-12345678'
    });
    return {
        ...durable,
        read: async (command) => {
            if (command.authority.kind === 'issued-session') {
                const existing = await authSessions.findBySessionId(command.authority.sessionId);
                if (!existing) {
                    await authSessions.putSession({
                        clientId: command.authority.principalId,
                        accessToken: `${command.authority.sessionId}-test-token`,
                        username: command.authority.principalId,
                        sessionId: command.authority.sessionId,
                        issuedAtEpochMs: command.authority.sessionIssuedAtEpochMs,
                        expiresAtEpochMs: command.authority.sessionExpiresAtEpochMs
                    });
                }
            }
            return await durable.read(command);
        }
    };
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
