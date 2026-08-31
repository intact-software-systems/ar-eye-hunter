import {
    validateGroupMutationRequest,
    validateGroupPresenceMutationRequest
} from '@shared-server/rallar-system/group-state/mutation/command-validation/group-mutation-request-validation.ts';
import { GroupMutationRejectedError } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { describe, expect, it } from 'vitest';

describe('group mutation request validation', () => {
    it('reports uninspectable values and sparse arrays as input issues without throwing', () => {
        const request = { requestId: 'request', actorPrincipalId: 'actor', actorSessionId: 'session' };
        const unreadable = Object.defineProperty({}, 'displayName', {
            enumerable: true,
            get() {
                throw new Error('unreadable');
            }
        });
        for (const metadata of [unreadable, Array(1)]) {
            expect(validateGroupMutationRequest('updateGroup', { ...request, metadata })).toEqual(expect.arrayContaining([expect.any(TypeError)]));
        }
    });
    it('returns all independent external-input issues without throwing', () => {
        const issues = validateGroupMutationRequest('updateGroup', { displayName: '', maxMembers: -1 });
        expect(issues).toEqual([
            new TypeError('Group updateGroup requestId must be a non-empty string'),
            new TypeError('Group updateGroup actorPrincipalId must be a non-empty string'),
            new TypeError('Group updateGroup actorSessionId must be a non-empty string'),
            new TypeError('Group updateGroup displayName must be a non-empty string'),
            new TypeError('Group updateGroup maxMembers must be a positive safe integer')
        ]);
    });
    it('rejects missing required and unexpected aggregate request keys with exact TypeErrors', () => {
        const missingRequestId = () =>
            validateGroupMutationRequest('updateGroup', {
                displayName: 'After',
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session'
            });
        expect(missingRequestId()).toEqual(expect.arrayContaining([expect.any(TypeError)]));
        expect(missingRequestId().map((issue) => issue.message)).toContain('Group updateGroup requestId must be a non-empty string');

        const missingGroupId = () =>
            validateGroupMutationRequest('createGroup', {
                displayName: 'Created group',
                kind: 'room',
                createdByPrincipalId: 'owner-1',
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: 'create-request'
            });
        expect(missingGroupId()).toEqual(expect.arrayContaining([expect.any(TypeError)]));
        expect(missingGroupId().map((issue) => issue.message)).toContain('Group createGroup groupId must be a non-empty string');

        const unexpectedKey = () =>
            validateGroupMutationRequest('updateGroup', {
                displayName: 'After',
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: 'update-request',
                unexpected: true
            });
        expect(unexpectedKey()).toEqual(expect.arrayContaining([expect.any(TypeError)]));
        expect(unexpectedKey().map((issue) => issue.message)).toContain('Group updateGroup request has unexpected key: unexpected');
    });

    // The lifecycle request rows exclude the criterion fence keys entirely, so
    // a principal request arrives without them and must validate cleanly.
    it.each([
        'planGroupLayout' as const,
        'activateGroup' as const,
        'reconfigureGroup' as const
    ])('accepts a fence-less principal %s request', (operation) => {
        expect(validateGroupMutationRequest(operation, {
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
            requestId: `${operation}-request`
        })).toEqual([]);
    });

    it('rejects a principal lifecycle request that spells a fence key', () => {
        const fenceKey = () =>
            validateGroupMutationRequest('activateGroup', {
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: 'fenced-activate',
                expectedFormationEpoch: 3
            });
        expect(fenceKey()).toEqual(expect.arrayContaining([expect.any(TypeError)]));
        expect(fenceKey().map((issue) => issue.message)).toContain('Group activateGroup request has unexpected key: expectedFormationEpoch');
    });

    it('accepts only canonical reconfigure landing values', () => {
        expect(validateGroupMutationRequest('reconfigureGroup', {
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
            requestId: 'reconfigure-apply',
            landing: 'apply'
        })).toEqual([]);

        const invalidLanding = () =>
            validateGroupMutationRequest('reconfigureGroup', {
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: 'reconfigure-invalid',
                landing: 'later'
            });
        expect(invalidLanding()).toEqual(expect.arrayContaining([expect.any(TypeError)]));
        expect(invalidLanding().map((issue) => issue.message)).toContain('Group reconfigureGroup landing is invalid');
    });

    it('requires non-empty authenticated actor identity on group mutation requests', () => {
        const missingPrincipal = () =>
            validateGroupMutationRequest('updateGroup', {
                displayName: 'After',
                actorSessionId: 'owner-session',
                requestId: 'missing-principal'
            });
        expect(missingPrincipal()).toEqual(expect.arrayContaining([expect.any(TypeError)]));
        expect(missingPrincipal().map((issue) => issue.message)).toContain('Group updateGroup actorPrincipalId must be a non-empty string');

        const emptyPrincipal = () =>
            validateGroupMutationRequest('updateGroup', {
                displayName: 'After',
                actorPrincipalId: '',
                actorSessionId: 'owner-session',
                requestId: 'empty-principal'
            });
        expect(emptyPrincipal()).toEqual(expect.arrayContaining([expect.any(TypeError)]));
        expect(emptyPrincipal().map((issue) => issue.message)).toContain('Group updateGroup actorPrincipalId must be a non-empty string');

        const missingSession = () =>
            validateGroupMutationRequest('updateGroup', {
                displayName: 'After',
                actorPrincipalId: 'owner-1',
                requestId: 'missing-session'
            });
        expect(missingSession()).toEqual(expect.arrayContaining([expect.any(TypeError)]));
        expect(missingSession().map((issue) => issue.message)).toContain('Group updateGroup actorSessionId must be a non-empty string');

        const emptySession = () =>
            validateGroupMutationRequest('updateGroup', {
                displayName: 'After',
                actorPrincipalId: 'owner-1',
                actorSessionId: '',
                requestId: 'empty-session'
            });
        expect(emptySession()).toEqual(expect.arrayContaining([expect.any(TypeError)]));
        expect(emptySession().map((issue) => issue.message)).toContain('Group updateGroup actorSessionId must be a non-empty string');
    });

    it('preserves omitted optional fields on accepted group mutation requests', () => {
        const request = Object.freeze({
            displayName: 'After',
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
            requestId: 'minimal-update'
        });

        expect(validateGroupMutationRequest('updateGroup', request)).toEqual([]);
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
        expect(missingGeneration()).toEqual(expect.arrayContaining([expect.any(TypeError)]));
        expect(missingGeneration().map((issue) => issue.message)).toContain('Group heartbeatPresence generationId must be a non-empty string');

        const emptyGeneration = () =>
            validateGroupPresenceMutationRequest('heartbeatPresence', {
                requestId: 'empty-generation',
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                generationId: ''
            });
        expect(emptyGeneration()).toEqual(expect.arrayContaining([expect.any(TypeError)]));
        expect(emptyGeneration().map((issue) => issue.message)).toContain('Group heartbeatPresence generationId must be a non-empty string');

        const minimalHeartbeat = Object.freeze({ generationId: 'generation-1' });
        expect(validateGroupPresenceMutationRequest('heartbeatPresence', minimalHeartbeat)).toEqual([]);
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
        expect(heartbeatBeforeConnect()).toEqual(expect.arrayContaining([expect.any(GroupMutationRejectedError)]));
        expect(heartbeatBeforeConnect().map((issue) => issue.message)).toContain(
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
        expect(expiryBeforeHeartbeat()).toEqual(expect.arrayContaining([expect.any(GroupMutationRejectedError)]));
        expect(expiryBeforeHeartbeat().map((issue) => issue.message)).toContain(
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
        expect(expiryBeforeHeartbeat()).toEqual(expect.arrayContaining([expect.any(GroupMutationRejectedError)]));
        expect(expiryBeforeHeartbeat().map((issue) => issue.message)).toContain(
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
        expect(disconnectBeforeHeartbeat()).toEqual(expect.arrayContaining([expect.any(GroupMutationRejectedError)]));
        expect(disconnectBeforeHeartbeat().map((issue) => issue.message)).toContain(
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
        expect(expiryBeforeHeartbeat()).toEqual(expect.arrayContaining([expect.any(GroupMutationRejectedError)]));
        expect(expiryBeforeHeartbeat().map((issue) => issue.message)).toContain(
            'Group disconnectPresence expiresAtEpochMs must not predate lastHeartbeatAtEpochMs'
        );
    });
});
