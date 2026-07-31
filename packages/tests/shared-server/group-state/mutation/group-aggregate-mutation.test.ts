import { describe, expect, it } from 'vitest';
import type {
  GroupMutationCommand,
  GroupMutationFacts,
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import {
  computeGroupMutation,
  validateGroupMutation,
} from '@shared-server/rallar-system/services/group-state-mutations.ts';

import {
  createMutationCommand,
  createMutationFacts,
  createMutationRead,
  deepFreeze,
} from './group-mutation-test-runtime.ts';

describe('group aggregate mutation computation', () => {
  it('keeps pure mutation computation synchronous, deterministic, and input preserving', () => {
    const command = deepFreeze(createMutationCommand());
    const read = deepFreeze(createMutationRead());
    const facts = deepFreeze(createMutationFacts());

    const first = computeGroupMutation({ command, read, facts });
    const second = computeGroupMutation({ command, read, facts });
    validateGroupMutation({ command, read, facts, computed: first });
    validateGroupMutation({ command, read, facts, computed: second });

    expect(first).toEqual(second);
    expect(command).toEqual(createMutationCommand());
    expect(read).toEqual(createMutationRead());
  });

  it('binds resolved join-code facts to the command operation and explicit intent', () => {
    const read = createMutationRead();
    const update = createMutationCommand();
    const explicitRotate = createMutationCommand({
      operation: 'rotateGroupJoinCode',
      input: {
        actorPrincipalId: 'alice',
        actorSessionId: 'alice-session',
        reason: null,
        traceId: null,
        joinCode: 'EXPLICIT',
        expiresAtEpochMs: null,
      },
    } as Partial<GroupMutationCommand>);
    const omittedRotate = createMutationCommand({
      operation: 'rotateGroupJoinCode',
      input: {
        actorPrincipalId: 'alice',
        actorSessionId: 'alice-session',
        reason: null,
        traceId: null,
        joinCode: null,
        expiresAtEpochMs: null,
      },
    } as Partial<GroupMutationCommand>);
    const codeFacts: GroupMutationFacts = {
      ...createMutationFacts(),
      resolvedJoinCode: 'OTHER',
      joinCodeVerifier: 'verifier',
    };

    expect(() => computeGroupMutation({ command: update, read, facts: codeFacts })).toThrow(
      /resolved.*join code|operation|unrelated/i,
    );
    expect(() =>
      computeGroupMutation({
        command: explicitRotate,
        read,
        facts: codeFacts,
      }),
    ).toThrow(/resolved.*join code|explicit|command/i);
    expect(() =>
      computeGroupMutation({
        command: omittedRotate,
        read,
        facts: createMutationFacts(),
      }),
    ).toThrow(/resolved.*join code|generated|missing/i);
  });
});
