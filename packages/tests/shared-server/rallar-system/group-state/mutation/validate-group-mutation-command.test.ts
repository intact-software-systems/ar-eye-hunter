import { describe, expect, expectTypeOf, it } from 'vitest';

import { validateGroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-command.ts';
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
                reason: null,
                traceId: null
            },
            commandHash: `sha256:${'0'.repeat(64)}`
        };
        expect(() => requireValidGroupMutationCommand(command)).toThrow(/command|key|hash/i);

        expect(() =>
            requireValidGroupMutationCommand(
                {
                    ...createMutationCommand(),
                    input: { ...createMutationCommand().input, unexpected: true }
                }
            )
        ).toThrow(/unexpected|key/i);

        expect(() =>
            requireValidGroupMutationCommand(
                createMutationCommand({
                    operation: 'rotateGroupJoinCode',
                    input: {
                        actorPrincipalId: 'alice',
                        actorSessionId: 'alice-session',
                        reason: null,
                        traceId: null,
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
            traceId: null,
            expectedFormationEpoch: null
        };

        expect(() =>
            requireValidGroupMutationCommand(
                createMutationCommand({
                    operation: 'startGroupFormation',
                    input: startFormationInput
                })
            )
        ).not.toThrow();

        expect(() =>
            requireValidGroupMutationCommand(
                {
                    ...createMutationCommand(),
                    operation: 'startGroupFormation',
                    input: { ...startFormationInput, expectedLayout: null }
                }
            )
        ).toThrow(/unexpected|key/i);
    });

    it('accepts presence commands without lifecycle fields', () => {
        expect(() =>
            requireValidGroupMutationCommand(
                createMutationCommand({
                    operation: 'connectPresence',
                    sessionId: 'presence-session',
                    input: {
                        actorPrincipalId: 'alice',
                        actorSessionId: 'alice-session',
                        reason: null,
                        traceId: null,
                        principalId: 'alice',
                        generationId: 'presence-generation',
                        connectedAtEpochMs: null,
                        lastHeartbeatAtEpochMs: null,
                        expiresAtEpochMs: null
                    }
                })
            )
        ).not.toThrow();
    });
});

function requireValidGroupMutationCommand(command: unknown): void {
    const issues = validateGroupMutationCommand(command);
    if (issues.length > 0) {
        throw issues[0].cause;
    }
}
