import { Temporal } from '@js-temporal/polyfill';

import { AppInboxType, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { encodeAppInboxCommand } from '@shared-server/rallar-system/app-inbox/app-inbox-registration-codecs.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import {
    type ClientMutationWritten,
    type ClientStateService,
    type ClientStateWritten
} from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { toAuthenticatedClientMutationContextId } from '@shared-server/rallar-system/client-state/inbox/authenticated-client-mutation-ingress.ts';
import type { JsonWireObject, JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { ClientStateEventStore } from '@shared-server/rallar-system/state-events/client-state-event-store.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import type { AppInboxTestDatabase } from '../app-inbox/test-support/app-inbox-test-database.ts';

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

    return result.right.result.snapshot;
}

export function requireRightWritten(
    result: Either<AppInboxFailure, ClientStateWritten>
): ClientMutationWritten {
    if (!result.right) {
        throw new Error(result.left?.message ?? 'Expected client app-inbox right result');
    }

    return result.right.result;
}

interface ClientTestEnqueueInput<TPayload> {
    readonly type: AppInboxType;
    readonly topicId?: string;
    readonly resourceId?: string;
    readonly contextId?: string;
    readonly senderId?: string;
    readonly data: TPayload;
}

interface AuthenticatedClientTestCommand {
    readonly scope: StateScope;
    readonly principalId: string;
    readonly requestId: string;
}

export async function processAppInbox<V>(
    service: AppClientInboxService,
    reader: InboxQueueReader,
    input: ClientTestEnqueueInput<V>
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
    input: ClientTestEnqueueInput<V>
): IssuedAuthSession {
    const data = requireJsonObject(
        encodeAppInboxCommand(input.data, 'Client mutation test authority'),
        'Client mutation test authority'
    );
    const request = requireJsonObject(data.request, 'Client mutation test request');
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
    input: ClientTestEnqueueInput<V>,
    authority: IssuedAuthSession
): Promise<Either<AppInboxFailure, ClientStateWritten>> {
    return await service.processAuthenticatedEntryUntilCompletion(
        toAuthenticatedClientTestEnqueue(input, authority),
        authority
    );
}

function toAuthenticatedClientTestEnqueue<V>(
    input: ClientTestEnqueueInput<V>,
    authority: IssuedAuthSession
): AppInboxEnqueueInput {
    const wireData = encodeAppInboxCommand(input.data, 'Client mutation test command');
    const data = readAuthenticatedClientTestCommand(wireData);
    return {
        ...input,
        topicId: input.type,
        resourceId: data.requestId,
        contextId: toAuthenticatedClientMutationContextId({
            scope: data.scope,
            principalId: data.principalId,
            callerClientId: authority.clientId,
            callerSessionId: authority.sessionId
        }),
        data: wireData
    };
}

function readAuthenticatedClientTestCommand(value: JsonWireValue): AuthenticatedClientTestCommand {
    const command = requireJsonObject(value, 'Client mutation test command');
    const scope = requireJsonObject(command.scope, 'Client mutation test scope');
    const request = requireJsonObject(command.request, 'Client mutation test request');
    if (
        typeof scope.applicationId !== 'string' ||
        typeof scope.workspaceId !== 'string' ||
        typeof command.principalId !== 'string' ||
        typeof request.requestId !== 'string'
    ) {
        throw new TypeError('Client mutation test command is invalid');
    }
    return {
        scope: {
            applicationId: scope.applicationId,
            workspaceId: scope.workspaceId
        },
        principalId: command.principalId,
        requestId: request.requestId
    };
}

function requireJsonObject(value: JsonWireValue | undefined, label: string): JsonWireObject {
    if (value === undefined || value === null || typeof value !== 'object' || isJsonWireArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

function isJsonWireArray(value: JsonWireValue): value is readonly JsonWireValue[] {
    return Array.isArray(value);
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

export async function readEntries(queue: InMemoryQueueBox): Promise<ResourceEntry[]> {
    const entries = await Promise.all((await queue.getAllKeys()).map((key) => queue.getItem(key)));

    return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
}

export function createAutoAuthorizingClientStateService(
    runtimeRepository: FakeRuntimeStateRepository,
    database: AppInboxTestDatabase,
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
