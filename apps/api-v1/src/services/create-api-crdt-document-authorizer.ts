import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';
import type { CrdtMutationResponseAudience } from '@shared-server/rallar-system/services/crdt-mutation-contracts.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import type { ClientStateSnapshotReadThroughCache } from '@shared-server/rallar-system/services/client-state-snapshot-read-through-cache.ts';
import type { AppInboxServiceOptions } from '@shared-server/rallar-system/services/AppInboxService.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/services/timing.ts';
import type { CurrentMutationAuthority } from './create-api-mutation-inbox-factories.ts';
import { createConfiguredApiMutationInboxFactories } from './create-api-mutation-inbox-factories.ts';

export type ApiCrdtDocumentAuthorizerOptions = Readonly<{
    readGroupSnapshot(ref: GroupRef): Promise<GroupSnapshot | null | undefined>;
    readClientSnapshot(ref: ClientPrincipalRef): Promise<ClientSnapshot | null | undefined>;
    nowEpochMs: () => number;
}>;

export function createApiCrdtDocumentAuthorizer(
    options: ApiCrdtDocumentAuthorizerOptions,
): CurrentMutationAuthority['authorizeDocument'] {
    return async (command, session) => {
        if (!responseAudienceMatchesDocument(command.responseAudience, command.document)) {
            return denied();
        }
        return await authorizeCrdtDocumentAccess(options, {
            document: command.document,
            actorPrincipalId: command.actor.principalId,
            sessionId: session.sessionId,
        });
    };
}

/**
 * Authorize a caller against a CRDT document by membership and live session,
 * independent of any response-routing audience. Every transport that reads or
 * mutates a document — the WS bridge, the durable mutation inbox, and the
 * synchronous HTTP catch-up route — must gate on this so authorization cannot be
 * bypassed by choosing a different transport.
 */
export async function authorizeCrdtDocumentAccess(
    options: ApiCrdtDocumentAuthorizerOptions,
    input: Readonly<{
        document: RallarCrdtDocumentRef;
        actorPrincipalId: string;
        sessionId: string;
    }>,
): Promise<ReturnType<typeof allowed> | ReturnType<typeof denied>> {
    const { document, actorPrincipalId, sessionId } = input;
    if (document.scope === 'room') {
        if (!document.roomRef) return denied();
        const snapshot = await options.readGroupSnapshot(document.roomRef);
        const member = snapshot?.members.find((candidate) =>
            candidate.principalId === actorPrincipalId &&
            candidate.status === 'active'
        );
        const activeSession = snapshot?.activeSessions.find((candidate) =>
            candidate.principalId === actorPrincipalId &&
            candidate.sessionId === sessionId &&
            candidate.status === 'active' &&
            candidate.expiresAtEpochMs > options.nowEpochMs()
        );
        return member && activeSession ? allowed() : denied();
    }
    if (document.scope === 'principal') {
        if (document.principalId !== actorPrincipalId) return denied();
        return await authorizeCurrentClientDocument(
            options,
            document.applicationId,
            document.workspaceId,
            document.principalId,
            sessionId,
        );
    }
    if (document.scope === 'app') {
        return await authorizeCurrentClientDocument(
            options,
            document.applicationId,
            document.workspaceId,
            actorPrincipalId,
            sessionId,
        );
    }
    return denied();
}

function responseAudienceMatchesDocument(
    responseAudience: CrdtMutationResponseAudience,
    document: RallarCrdtDocumentRef,
): boolean {
    if (document.scope === 'room') {
        const roomRef = document.roomRef;
        if (!roomRef) return false;
        return responseAudience.kind === 'room' &&
            responseAudience.contextId === roomRef.groupId;
    }
    if (document.scope === 'principal') {
        return responseAudience.kind === 'principal' &&
            responseAudience.contextId === document.principalId;
    }
    if (document.scope === 'app') {
        return responseAudience.kind === 'app' &&
            responseAudience.contextId === document.applicationId;
    }
    return false;
}

export function findCurrentClientSnapshot(
    cache: ClientStateSnapshotReadThroughCache,
    ref: Readonly<{ applicationId: string; workspaceId?: string; principalId: string }>,
): ClientSnapshot | undefined {
    return cache.findByRef({
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
        principalId: ref.principalId,
    });
}

export function createApiCrdtMutationInboxFactories(input: Readonly<{
    database: PSqlSql;
    serviceId: string;
    timing: RallarTimingSink | undefined;
    options: AppInboxServiceOptions;
    repositories: Readonly<{
        authSessionRepository: Readonly<{
            findBySessionId: CurrentMutationAuthority['readSession'];
        }>;
        groupsRepository: Readonly<{
            readSnapshot(ref: GroupRef): Promise<GroupSnapshot | null | undefined>;
        }>;
        clientsRepository: Readonly<{
            readSnapshot(ref: ClientPrincipalRef): Promise<ClientSnapshot | null | undefined>;
        }>;
    }>;
}>): ReturnType<typeof createConfiguredApiMutationInboxFactories> {
    const { authSessionRepository, groupsRepository, clientsRepository } = input.repositories;
    return createConfiguredApiMutationInboxFactories({
        resourceInboxRepository: new ResourceInboxRepository(input.database),
        resourceInboxResultsRepository: new ResourceInboxResultsRepository(input.database),
        database: input.database,
        serviceId: input.serviceId,
        timing: input.timing,
        options: input.options,
        readSession: (sessionId) => authSessionRepository.findBySessionId(sessionId),
        authorizeDocument: createApiCrdtDocumentAuthorizer({
            readGroupSnapshot: (ref) => groupsRepository.readSnapshot(ref),
            readClientSnapshot: (ref) => clientsRepository.readSnapshot(ref),
            nowEpochMs: input.options.nowEpochMs ?? Date.now,
        }),
    });
}

function allowed(): Readonly<{ allowed: true; code: 'allowed' }> {
    return { allowed: true, code: 'allowed' };
}

function denied(): Readonly<{ allowed: false; code: 'authorization-scope-denied' }> {
    return { allowed: false, code: 'authorization-scope-denied' };
}

async function authorizeCurrentClientDocument(
    options: ApiCrdtDocumentAuthorizerOptions,
    applicationId: string,
    workspaceId: string | undefined,
    principalId: string,
    sessionId: string,
): Promise<ReturnType<typeof allowed> | ReturnType<typeof denied>> {
    const snapshot = await options.readClientSnapshot({
        applicationId,
        workspaceId: workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
        principalId,
    });
    const active = snapshot?.principal.status === 'active' &&
        snapshot.activeSessions.some((candidate) =>
            candidate.sessionId === sessionId && candidate.status === 'active' &&
            candidate.expiresAtEpochMs > options.nowEpochMs()
        );
    return active ? allowed() : denied();
}
