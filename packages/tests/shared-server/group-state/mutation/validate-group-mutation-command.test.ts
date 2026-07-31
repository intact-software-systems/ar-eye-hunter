import { existsSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ConnectGroupPresenceSessionRequest,
  GroupJoinCodeResponse,
  HeartbeatGroupPresenceSessionRequest,
} from '@shared/api/state-types.ts';
import { type GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { validateGroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/validate-group-mutation-command.ts';

const commandValidationOwner =
  'packages/shared-server/rallar-system/group-state/mutation/validate-group-mutation-command.ts';

describe('group mutation command validation', () => {
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
        traceId: null,
      },
      commandHash: `sha256:${'0'.repeat(64)}`,
    } as never);
    expect(() => validateGroupMutationCommand(command)).toThrow(/command|key|hash/i);

    expect(() =>
      validateGroupMutationCommand(
        createMutationCommand({
          input: {
            ...createMutationCommand().input,
            unexpected: true,
          },
        } as never),
      ),
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
            expiresAtEpochMs: null,
          },
        } as Partial<GroupMutationCommand>),
      ),
    ).not.toThrow();
  });
});

function createMutationCommand(
  overrides: Partial<GroupMutationCommand> = {},
): GroupMutationCommand {
  return {
    operation: 'updateGroup',
    aggregateRef: {
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      groupId: 'pure-room',
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
      traceId: null,
    },
    ...overrides,
  } as GroupMutationCommand;
}
