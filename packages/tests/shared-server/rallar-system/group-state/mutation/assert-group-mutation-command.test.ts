import { describe, expect, expectTypeOf, it } from 'vitest';

import { assertGroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/command-validation/assert-group-mutation-command.ts';
import { type GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import type { ConnectGroupPresenceSessionRequest, GroupJoinCodeResponse, HeartbeatGroupPresenceSessionRequest } from '@shared/api/state-types.ts';

import { createMutationCommand } from '../group-state-concurrency-test-fixtures.ts';

describe('group mutation command validation', () => {
    it('keeps create and update metadata readonly in the public command contract', () => {
        type CreateCommand = Extract<GroupMutationCommand, { operation: 'createGroup'; }>;
        type UpdateCommand = Extract<GroupMutationCommand, { operation: 'updateGroup'; }>;
        const mutateCreateMetadata = (command: CreateCommand): void => {
            // @ts-expect-error Public command metadata must remain readonly.
            command.input.metadata.reviewMutation = true;
        };
        const mutateUpdateMetadata = (command: UpdateCommand): void => {
            if (!command.input.metadata) {
                return;
            }
            // @ts-expect-error Public command metadata must remain readonly.
            command.input.metadata.reviewMutation = true;
        };

        expect(mutateCreateMetadata).toBeTypeOf('function');
        expect(mutateUpdateMetadata).toBeTypeOf('function');
    });

    it('makes generation identity mandatory and rejects caller-controlled command hashes', () => {
        expectTypeOf<ConnectGroupPresenceSessionRequest>()
            .toHaveProperty('generationId')
            .toEqualTypeOf<string>();
        expectTypeOf<HeartbeatGroupPresenceSessionRequest>()
            .toHaveProperty('generationId')
            .toEqualTypeOf<string>();
        expectTypeOf<ConnectGroupPresenceSessionRequest>().not.toHaveProperty('commandHash');
        expectTypeOf<GroupJoinCodeResponse>()
            .toHaveProperty('expiresAtEpochMs')
            .toEqualTypeOf<number>();

        const command = {
            ...createMutationCommand(),
            input: {
                displayName: 'After',
                actorPrincipalId: 'alice',
                actorSessionId: null,
                reason: null
            },
            commandHash: `sha256:${'0'.repeat(64)}`
        };
        expect(() => assertGroupMutationCommand(command)).toThrow(/command|key|hash/i);

        expect(() =>
            assertGroupMutationCommand(
                {
                    ...createMutationCommand(),
                    input: { ...createMutationCommand().input, unexpected: true }
                }
            )
        ).toThrow(/unexpected|key/i);

        expect(() =>
            assertGroupMutationCommand(
                createMutationCommand({
                    operation: 'rotateGroupJoinCode',
                    input: {
                        actorPrincipalId: 'alice',
                        actorSessionId: 'alice-session',
                        reason: null,
                        joinCode: null,
                        expiresAtEpochMs: null
                    }
                })
            )
        ).not.toThrow();
    });

    it('accepts the start-formation key row and rejects a payload outside it', () => {
        const startFormationInput = {
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            reason: null,
            expectedFormationEpoch: null
        };

        expect(() =>
            assertGroupMutationCommand(
                createMutationCommand({
                    operation: 'startGroupFormation',
                    input: startFormationInput
                })
            )
        ).not.toThrow();

        expect(() =>
            assertGroupMutationCommand(
                {
                    ...createMutationCommand(),
                    operation: 'startGroupFormation',
                    input: { ...startFormationInput, expectedLayout: null }
                }
            )
        ).toThrow(/unexpected|key/i);
    });

    it('accepts a publication command naming a user topic and refuses one naming neither permission', () => {
        const command = {
            ...createMutationCommand(),
            operation: 'grantGroupPublication',
            targetPrincipalId: 'bob',
            input: {
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                reason: null,
                topicId: 'room.feed',
                publish: false,
                subscribe: true
            }
        };

        expect(() => assertGroupMutationCommand(command)).not.toThrow();
        expect(() => assertGroupMutationCommand({ ...command, operation: 'revokeGroupPublication' })).not.toThrow();
        expect(() => assertGroupMutationCommand({ ...command, input: { ...command.input, subscribe: false } })).toThrow(
            /publish or subscribe/
        );
        expect(() => assertGroupMutationCommand({ ...command, input: { ...command.input, topicId: 'rallar.feed' } }))
            .toThrow(/reserved/i);
        expect(() => assertGroupMutationCommand({ ...command, input: { ...command.input, publish: 'yes' } })).toThrow(
            /boolean/
        );
    });

    it('accepts presence commands without lifecycle fields', () => {
        expect(() =>
            assertGroupMutationCommand(
                createMutationCommand({
                    operation: 'connectPresence',
                    sessionId: 'presence-session',
                    input: {
                        actorPrincipalId: 'alice',
                        actorSessionId: 'alice-session',
                        reason: null,
                        principalId: 'alice',
                        generationId: 'presence-generation',
                        connectionGenerationId: 'presence-ws-generation',
                        connectedAtEpochMs: null,
                        lastHeartbeatAtEpochMs: null,
                        expiresAtEpochMs: null
                    }
                })
            )
        ).not.toThrow();
    });
});
