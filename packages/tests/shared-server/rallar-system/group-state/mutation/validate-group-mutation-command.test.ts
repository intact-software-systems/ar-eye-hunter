import { validateGroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-command.ts';
import { type GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import type { ConnectGroupPresenceSessionRequest, GroupJoinCodeResponse, HeartbeatGroupPresenceSessionRequest } from '@shared/api/state-types.ts';
import { existsSync } from 'node:fs';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

vi.mock('@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts', async (importOriginal) => {
    const contracts = await importOriginal<typeof import('@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts')>();
    return {
        ...contracts,
        isGroupLifecycleTransitionOperation(operation: GroupMutationCommand['operation']) {
            if (operation === 'connectPresence') {
                throw new Error('Presence validation must not evaluate lifecycle-transition policy');
            }
            return contracts.isGroupLifecycleTransitionOperation(operation);
        }
    };
});

const commandValidationOwner = 'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-command.ts';

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
    it('locates command validation at the canonical mutation owner', () => {
        expect(existsSync(commandValidationOwner)).toBe(true);
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

        const command = createMutationCommand({
            input: {
                displayName: 'After',
                actorPrincipalId: 'alice',
                actorSessionId: null,
                reason: null,
                traceId: null
            },
            commandHash: `sha256:${'0'.repeat(64)}`
        } as never);
        expect(() => validateGroupMutationCommand(command)).toThrow(/command|key|hash/i);

        expect(() =>
            validateGroupMutationCommand(
                createMutationCommand({
                    input: {
                        ...createMutationCommand().input,
                        unexpected: true
                    }
                } as never)
            )
        ).toThrow(/unexpected|key/i);

        expect(() =>
            validateGroupMutationCommand(
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
                } as Partial<GroupMutationCommand>)
            )
        ).not.toThrow();
    });

    // Slice 5e's dark `start`: with no route mounted, the declared key row is
    // the only thing between a hand-built payload and the compute, and nothing
    // else exercises the arm.
    it('accepts the start-formation key row and rejects a payload outside it', () => {
        const startFormationInput = {
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            reason: null,
            traceId: null,
            expectedFormationEpoch: null
        };

        expect(() =>
            validateGroupMutationCommand(
                createMutationCommand({
                    operation: 'startGroupFormation',
                    input: startFormationInput
                } as Partial<GroupMutationCommand>)
            )
        ).not.toThrow();

        expect(() =>
            validateGroupMutationCommand(
                createMutationCommand({
                    operation: 'startGroupFormation',
                    input: { ...startFormationInput, expectedLayout: null }
                } as Partial<GroupMutationCommand>)
            )
        ).toThrow(/unexpected|key/i);
    });

    it('routes presence validation before lifecycle-transition policy', () => {
        expect(() =>
            validateGroupMutationCommand(
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
                } as Partial<GroupMutationCommand>)
            )
        ).not.toThrow();
    });
});

function createMutationCommand(
    overrides: Partial<GroupMutationCommand> = {}
): GroupMutationCommand {
    return {
        operation: 'updateGroup',
        aggregateRef: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'pure-room'
        },
        commandId: 'pure-command',
        requestId: 'pure-command',
        input: {
            slug: null,
            displayName: 'After',
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
        },
        ...overrides
    } as GroupMutationCommand;
}
