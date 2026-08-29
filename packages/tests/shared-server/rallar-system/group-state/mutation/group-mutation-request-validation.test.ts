import {
    validateGroupMutationRequest,
    validateGroupPresenceMutationRequest
} from '@shared-server/rallar-system/group-state/mutation/command-validation/group-mutation-request-validation.ts';
import { GroupMutationRejectedError } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const requestValidationOwner = 'packages/shared-server/rallar-system/group-state/mutation/command-validation/group-mutation-request-validation.ts';

describe('group mutation request validation', () => {
    it('locates request validation at the canonical mutation owner', () => {
        expect(existsSync(requestValidationOwner)).toBe(true);
    });

    it('rejects missing required and unexpected aggregate request keys with exact TypeErrors', () => {
        const missingRequestId = () =>
            validateGroupMutationRequest('updateGroup', {
                displayName: 'After',
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session'
            });
        expect(missingRequestId).toThrowError(TypeError);
        expect(missingRequestId).toThrowError('Group updateGroup requestId must be a non-empty string');

        const missingGroupId = () =>
            validateGroupMutationRequest('createGroup', {
                displayName: 'Created group',
                kind: 'room',
                createdByPrincipalId: 'owner-1',
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: 'create-request'
            });
        expect(missingGroupId).toThrowError(TypeError);
        expect(missingGroupId).toThrowError('Group createGroup groupId must be a non-empty string');

        const unexpectedKey = () =>
            validateGroupMutationRequest('updateGroup', {
                displayName: 'After',
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: 'update-request',
                unexpected: true
            });
        expect(unexpectedKey).toThrowError(TypeError);
        expect(unexpectedKey).toThrowError('Group updateGroup request has unexpected key: unexpected');
    });

    // The lifecycle request rows exclude the criterion fence keys entirely, so
    // a principal request arrives without them and must validate cleanly.
    it.each([
        'startGroupEstablishment' as const,
        'activateGroup' as const,
        'reopenGroupEstablishment' as const
    ])('accepts a fence-less principal %s request', (operation) => {
        expect(() =>
            validateGroupMutationRequest(operation, {
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: `${operation}-request`
            })
        ).not.toThrow();
    });

    it('rejects a principal lifecycle request that spells a fence key', () => {
        const fenceKey = () =>
            validateGroupMutationRequest('activateGroup', {
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: 'fenced-activate',
                expectedFormationEpoch: 3
            });
        expect(fenceKey).toThrowError(TypeError);
        expect(fenceKey).toThrowError(
            'Group activateGroup request has unexpected key: expectedFormationEpoch'
        );
    });

    it('accepts only canonical reconfigure landing values', () => {
        expect(() =>
            validateGroupMutationRequest('reconfigureGroup', {
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: 'reconfigure-apply',
                landing: 'apply'
            })
        ).not.toThrow();

        const invalidLanding = () =>
            validateGroupMutationRequest('reconfigureGroup', {
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: 'reconfigure-invalid',
                landing: 'later'
            });
        expect(invalidLanding).toThrowError(TypeError);
        expect(invalidLanding).toThrowError('Group reconfigureGroup landing is invalid');
    });

    it('requires non-empty authenticated actor identity on group mutation requests', () => {
        const missingPrincipal = () =>
            validateGroupMutationRequest('updateGroup', {
                displayName: 'After',
                actorSessionId: 'owner-session',
                requestId: 'missing-principal'
            });
        expect(missingPrincipal).toThrowError(TypeError);
        expect(missingPrincipal).toThrowError(
            'Group updateGroup actorPrincipalId must be a non-empty string'
        );

        const emptyPrincipal = () =>
            validateGroupMutationRequest('updateGroup', {
                displayName: 'After',
                actorPrincipalId: '',
                actorSessionId: 'owner-session',
                requestId: 'empty-principal'
            });
        expect(emptyPrincipal).toThrowError(TypeError);
        expect(emptyPrincipal).toThrowError(
            'Group updateGroup actorPrincipalId must be a non-empty string'
        );

        const missingSession = () =>
            validateGroupMutationRequest('updateGroup', {
                displayName: 'After',
                actorPrincipalId: 'owner-1',
                requestId: 'missing-session'
            });
        expect(missingSession).toThrowError(TypeError);
        expect(missingSession).toThrowError(
            'Group updateGroup actorSessionId must be a non-empty string'
        );

        const emptySession = () =>
            validateGroupMutationRequest('updateGroup', {
                displayName: 'After',
                actorPrincipalId: 'owner-1',
                actorSessionId: '',
                requestId: 'empty-session'
            });
        expect(emptySession).toThrowError(TypeError);
        expect(emptySession).toThrowError(
            'Group updateGroup actorSessionId must be a non-empty string'
        );
    });

    it('preserves omitted optional fields on accepted group mutation requests', () => {
        const request = Object.freeze({
            displayName: 'After',
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
            requestId: 'minimal-update'
        });

        expect(() => validateGroupMutationRequest('updateGroup', request)).not.toThrow();
        expect(request).toEqual({
            displayName: 'After',
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
            requestId: 'minimal-update'
        });
        expect(Object.hasOwn(request, 'reason')).toBe(false);
        expect(Object.hasOwn(request, 'traceId')).toBe(false);
    });

    it('requires presence generation identity while preserving optional omission', () => {
        const missingGeneration = () =>
            validateGroupPresenceMutationRequest('heartbeatPresence', {
                requestId: 'missing-generation',
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session'
            });
        expect(missingGeneration).toThrowError(TypeError);
        expect(missingGeneration).toThrowError(
            'Group heartbeatPresence generationId must be a non-empty string'
        );

        const emptyGeneration = () =>
            validateGroupPresenceMutationRequest('heartbeatPresence', {
                requestId: 'empty-generation',
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                generationId: ''
            });
        expect(emptyGeneration).toThrowError(TypeError);
        expect(emptyGeneration).toThrowError(
            'Group heartbeatPresence generationId must be a non-empty string'
        );

        const minimalHeartbeat = Object.freeze({ generationId: 'generation-1' });
        expect(() => validateGroupPresenceMutationRequest('heartbeatPresence', minimalHeartbeat)).not.toThrow();
        expect(minimalHeartbeat).toEqual({ generationId: 'generation-1' });
        expect(Object.hasOwn(minimalHeartbeat, 'lastHeartbeatAtEpochMs')).toBe(false);
        expect(Object.hasOwn(minimalHeartbeat, 'expiresAtEpochMs')).toBe(false);
    });

    it('rejects reversed connect timestamps with exact domain errors', () => {
        const heartbeatBeforeConnect = () =>
            validateGroupPresenceMutationRequest('connectPresence', {
                requestId: 'connect-heartbeat-before-connect',
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                principalId: 'owner-1',
                generationId: 'generation-1',
                connectedAtEpochMs: 2_000,
                lastHeartbeatAtEpochMs: 1_999,
                expiresAtEpochMs: 3_000
            });
        expect(heartbeatBeforeConnect).toThrowError(GroupMutationRejectedError);
        expect(heartbeatBeforeConnect).toThrowError(
            'Group connectPresence lastHeartbeatAtEpochMs must not predate connectedAtEpochMs'
        );

        const expiryBeforeHeartbeat = () =>
            validateGroupPresenceMutationRequest('connectPresence', {
                requestId: 'connect-expiry-before-heartbeat',
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                principalId: 'owner-1',
                generationId: 'generation-1',
                connectedAtEpochMs: 1_000,
                lastHeartbeatAtEpochMs: 2_000,
                expiresAtEpochMs: 1_999
            });
        expect(expiryBeforeHeartbeat).toThrowError(GroupMutationRejectedError);
        expect(expiryBeforeHeartbeat).toThrowError(
            'Group connectPresence expiresAtEpochMs must not predate lastHeartbeatAtEpochMs'
        );
    });

    it('rejects reversed heartbeat timestamps with the exact domain error', () => {
        const expiryBeforeHeartbeat = () =>
            validateGroupPresenceMutationRequest('heartbeatPresence', {
                requestId: 'heartbeat-expiry-before-heartbeat',
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                generationId: 'generation-1',
                lastHeartbeatAtEpochMs: 2_000,
                expiresAtEpochMs: 1_999
            });
        expect(expiryBeforeHeartbeat).toThrowError(GroupMutationRejectedError);
        expect(expiryBeforeHeartbeat).toThrowError(
            'Group heartbeatPresence expiresAtEpochMs must not predate lastHeartbeatAtEpochMs'
        );
    });

    it('rejects reversed disconnect timestamps with exact domain errors', () => {
        const disconnectBeforeHeartbeat = () =>
            validateGroupPresenceMutationRequest('disconnectPresence', {
                requestId: 'disconnect-before-heartbeat',
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                generationId: 'generation-1',
                disconnectedAtEpochMs: 1_999,
                lastHeartbeatAtEpochMs: 2_000,
                expiresAtEpochMs: 3_000
            });
        expect(disconnectBeforeHeartbeat).toThrowError(GroupMutationRejectedError);
        expect(disconnectBeforeHeartbeat).toThrowError(
            'Group disconnectPresence disconnectedAtEpochMs must not predate lastHeartbeatAtEpochMs'
        );

        const expiryBeforeHeartbeat = () =>
            validateGroupPresenceMutationRequest('disconnectPresence', {
                requestId: 'disconnect-expiry-before-heartbeat',
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                generationId: 'generation-1',
                disconnectedAtEpochMs: 3_000,
                lastHeartbeatAtEpochMs: 2_000,
                expiresAtEpochMs: 1_999
            });
        expect(expiryBeforeHeartbeat).toThrowError(GroupMutationRejectedError);
        expect(expiryBeforeHeartbeat).toThrowError(
            'Group disconnectPresence expiresAtEpochMs must not predate lastHeartbeatAtEpochMs'
        );
    });
});
