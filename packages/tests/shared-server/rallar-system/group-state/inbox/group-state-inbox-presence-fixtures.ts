import { expect } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';

import {
    processAuthenticated,
    requireGroupStateResult,
    SCOPE,
    type AuthorityHarness
} from './group-state-inbox-test-runtime.ts';

/** Activates a member through the owner's session so the member can connect presence afterwards. */
export async function activateMember(
    harness: AuthorityHarness,
    groupId: string,
    principalId: string
): Promise<void> {
    const activated = await processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: harness.sessions.owner,
        input: {
            traceId: 'trace-test-fixture',
            type: AppInboxType.GROUP_MEMBER_UPSERT,
            resourceId: `activate-${principalId}`,
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                principalId,
                request: {
                    status: 'active',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: `activate-${principalId}`
                }
            }
        }
    });
    expect(requireGroupStateResult(activated).status).toBe('ok');
}

export function presenceConnectEnqueue(
    groupId: string,
    principalId: string,
    nowEpochMs: number
): AuthenticatedGroupMutationEnqueue {
    return {
        type: AppInboxType.GROUP_PRESENCE_CONNECT,
        resourceId: `connect-${principalId}`,
        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
        senderId: principalId,
        traceId: 'trace-test-fixture',
        data: {
            scope: SCOPE,
            groupId,
            sessionId: `${principalId}-session`,
            request: {
                principalId,
                generationId: `${principalId}-generation`,
                connectionGenerationId: `${principalId}-ws-generation`,
                connectedAtEpochMs: nowEpochMs,
                lastHeartbeatAtEpochMs: nowEpochMs,
                expiresAtEpochMs: nowEpochMs + 60_000,
                actorPrincipalId: principalId,
                actorSessionId: `${principalId}-session`,
                requestId: `connect-${principalId}`
            }
        }
    };
}
