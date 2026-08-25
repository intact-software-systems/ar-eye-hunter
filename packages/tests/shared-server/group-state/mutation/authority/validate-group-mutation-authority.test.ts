import { validateGroupMutationAuthority } from '@shared-server/rallar-system/group-state/mutation/authority/validate-group-mutation-authority.ts';
import type {
    GroupMutationCommand,
    GroupMutationFacts
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { describe, expect, it } from 'vitest';

describe('group mutation authority validation', () => {
    it('accepts facts whose authenticated authority exactly owns the command actor', () => {
        expect(() => validateGroupMutationAuthority(updateCommand(), authenticatedFacts())).not.toThrow();
    });

    it('rejects facts whose authenticated authority differs from the command actor', () => {
        expect(() =>
            validateGroupMutationAuthority(updateCommand(), {
                ...authenticatedFacts(),
                authenticatedAuthority: {
                    principalId: 'mallory',
                    sessionId: 'mallory-session'
                }
            })
        ).toThrow('Group mutation actor differs from authenticated authority');
    });
});

function updateCommand(): Extract<GroupMutationCommand, { operation: 'updateGroup'; }> {
    return {
        operation: 'updateGroup',
        aggregateRef: {
            applicationId: 'test-app',
            workspaceId: 'test-workspace',
            groupId: 'test-group'
        },
        commandId: 'command-1',
        requestId: 'request-1',
        input: {
            slug: null,
            displayName: 'Updated group',
            description: null,
            kind: null,
            status: null,
            joinMode: null,
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: null,
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            reason: null,
            traceId: null
        }
    };
}

function authenticatedFacts(): GroupMutationFacts {
    return {
        nowEpochMs: 1_000,
        expireAtEpochMs: 2_000,
        serviceId: 'test-service',
        eventId: 'event-1',
        commandHash: `sha256:${'a'.repeat(64)}`,
        resolvedJoinCode: null,
        joinCodeVerifier: null,
        internalAuthority: 'none',
        authenticatedAuthority: {
            principalId: 'alice',
            sessionId: 'alice-session'
        },
        attemptCount: 1
    };
}
