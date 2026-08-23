import type {
    ClientPrincipalRef,
    ClientPrincipalStatus,
    ClientSessionStatus,
    ClientSnapshot
} from '@shared/api/client-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';

import type {
    CrdtMutationResponseAudience
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import type { GroupMemberStatus, GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';
import type { RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';

import { type ClientStateSnapshotReadThroughCache } from '@shared-server/rallar-system/client-state/snapshot/client-state-snapshot-read-through-cache.ts';

import type {
    CurrentMutationAuthority,
    CurrentMutationDocumentAuthorization
} from './create-api-crdt-inbox-service.ts';

export interface ApiCrdtGroupAuthorizationMember {
    readonly principalId: string;
    readonly status: GroupMemberStatus;
}

export interface ApiCrdtGroupAuthorizationSession {
    readonly principalId: string;
    readonly sessionId: string;
    readonly status: GroupPresenceSession['status'];
    readonly expiresAtEpochMs: number;
}

export interface ApiCrdtGroupAuthorizationSnapshot {
    readonly members: readonly ApiCrdtGroupAuthorizationMember[];
    readonly activeSessions: readonly ApiCrdtGroupAuthorizationSession[];
}

export interface ApiCrdtClientAuthorizationPrincipal {
    readonly status: ClientPrincipalStatus;
}

export interface ApiCrdtClientAuthorizationSession {
    readonly sessionId: string;
    readonly status: ClientSessionStatus;
    readonly expiresAtEpochMs: number;
}

export interface ApiCrdtClientAuthorizationSnapshot {
    readonly principal: ApiCrdtClientAuthorizationPrincipal;
    readonly activeSessions: readonly ApiCrdtClientAuthorizationSession[];
}

export interface ApiCrdtDocumentAuthorizerDependencies {
    readonly readGroupSnapshot: (
        ref: GroupRef
    ) => Promise<ApiCrdtGroupAuthorizationSnapshot | null | undefined>;
    readonly readClientSnapshot: (
        ref: ClientPrincipalRef
    ) => Promise<ApiCrdtClientAuthorizationSnapshot | null | undefined>;
    readonly nowEpochMs: () => number;
}

interface AuthorizeCurrentClientDocumentInput {
    readonly applicationId: string;
    readonly workspaceId: string | undefined;
    readonly principalId: string;
    readonly sessionId: string;
}

export interface AuthorizeCrdtDocumentAccessInput {
    readonly document: RallarCrdtDocumentRef;
    readonly actorPrincipalId: string;
    readonly sessionId: string;
}

export interface CurrentClientSnapshotRef {
    readonly applicationId: string;
    readonly workspaceId?: string;
    readonly principalId: string;
}

export function createApiCrdtDocumentAuthorizer(
    dependencies: ApiCrdtDocumentAuthorizerDependencies
): CurrentMutationAuthority['authorizeDocument'] {
    const authorizeDocumentAccess = createApiCrdtDocumentAccessAuthorizer(dependencies);
    return async (command, session) => {
        if (!responseAudienceMatchesDocument(command.responseAudience, command.document)) {
            return denied();
        }
        return await authorizeDocumentAccess({
            document: command.document,
            actorPrincipalId: command.actor.principalId,
            sessionId: session.sessionId
        });
    };
}

export function createApiCrdtDocumentAccessAuthorizer(
    dependencies: ApiCrdtDocumentAuthorizerDependencies
): (
    input: AuthorizeCrdtDocumentAccessInput
) => Promise<CurrentMutationDocumentAuthorization> {
    return async (input) => {
        const { document, actorPrincipalId, sessionId } = input;
        if (document.scope === 'room') {
            return await authorizeRoomDocument(dependencies, input);
        }
        if (document.scope === 'principal') {
            if (document.principalId !== actorPrincipalId) {
                return denied();
            }
            return await authorizeCurrentClientDocument(
                dependencies,
                {
                    applicationId: document.applicationId,
                    workspaceId: document.workspaceId,
                    principalId: document.principalId,
                    sessionId
                }
            );
        }
        if (document.scope === 'app') {
            return await authorizeCurrentClientDocument(
                dependencies,
                {
                    applicationId: document.applicationId,
                    workspaceId: document.workspaceId,
                    principalId: actorPrincipalId,
                    sessionId
                }
            );
        }
        return denied();
    };
}

async function authorizeRoomDocument(
    dependencies: ApiCrdtDocumentAuthorizerDependencies,
    input: AuthorizeCrdtDocumentAccessInput
): Promise<CurrentMutationDocumentAuthorization> {
    const roomRef = input.document.roomRef;
    if (!roomRef) {
        return denied();
    }
    const snapshot = await dependencies.readGroupSnapshot(roomRef);
    const member = snapshot?.members.find((candidate) =>
        candidate.principalId === input.actorPrincipalId &&
        candidate.status === 'active'
    );
    const activeSession = snapshot?.activeSessions.find((candidate) =>
        candidate.principalId === input.actorPrincipalId &&
        candidate.sessionId === input.sessionId &&
        candidate.status === 'active'
    );
    const sessionIsCurrent = activeSession !== undefined &&
        activeSession.expiresAtEpochMs > dependencies.nowEpochMs();
    return member !== undefined && sessionIsCurrent ? allowed() : denied();
}

async function authorizeCurrentClientDocument(
    dependencies: ApiCrdtDocumentAuthorizerDependencies,
    input: AuthorizeCurrentClientDocumentInput
): Promise<CurrentMutationDocumentAuthorization> {
    const { applicationId, workspaceId, principalId, sessionId } = input;
    const snapshot = await dependencies.readClientSnapshot({
        applicationId,
        workspaceId: workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
        principalId
    });
    if (snapshot?.principal.status !== 'active') {
        return denied();
    }
    const activeSession = snapshot.activeSessions.find((candidate) =>
        candidate.sessionId === sessionId && candidate.status === 'active'
    );
    const active = activeSession !== undefined &&
        activeSession.expiresAtEpochMs > dependencies.nowEpochMs();
    return active ? allowed() : denied();
}

function responseAudienceMatchesDocument(
    responseAudience: CrdtMutationResponseAudience,
    document: RallarCrdtDocumentRef
): boolean {
    if (document.scope === 'room') {
        const roomRef = document.roomRef;
        if (!roomRef) {
            return false;
        }
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
    ref: CurrentClientSnapshotRef
): ClientSnapshot | undefined {
    return cache.findByRef({
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
        principalId: ref.principalId
    });
}

function allowed(): CurrentMutationDocumentAuthorization {
    return { allowed: true, code: 'allowed' };
}

function denied(): CurrentMutationDocumentAuthorization {
    return { allowed: false, code: 'authorization-scope-denied' };
}
