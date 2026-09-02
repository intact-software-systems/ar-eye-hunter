import { toAggregateMutationCommand } from '@shared-server/rallar-system/group-state/group-mutation-command.ts';
import { validateGroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-command.ts';
import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { CreateGroupRequest } from '@shared/api/state-types.ts';
import { describe, expect, it } from 'vitest';

const SCOPE = { applicationId: 'app-1', workspaceId: 'ws-1' } as const;

function toCreateCommand(lifecyclePolicy?: CreateGroupRequest['lifecyclePolicy']): Extract<GroupMutationCommand, { operation: 'createGroup'; }> {
    const request: CreateGroupRequest = {
        groupId: 'group-1',
        displayName: 'Group One',
        kind: 'room',
        createdByPrincipalId: 'owner-1',
        actorPrincipalId: 'owner-1',
        ...(lifecyclePolicy === undefined ? {} : { lifecyclePolicy })
    };

    const command = toAggregateMutationCommand(
        {
            operation: 'createGroup',
            scope: SCOPE,
            groupId: 'group-1',
            targetPrincipalId: null,
            sessionId: null,
            request
        },
        () => 'command-1'
    );
    if (command.operation !== 'createGroup') {
        throw new Error('Expected a createGroup command');
    }

    return command;
}

describe('createGroup lifecycle policy input', () => {
    // The load-bearing property, asserted on the wire shape rather than on
    // behaviour: a create that does not mention a policy must produce exactly
    // the command it produces today, because the event id is derived from it.
    it('leaves the command untouched when no policy is supplied', () => {
        const command = toCreateCommand();

        expect('lifecyclePolicy' in command.input).toBe(false);
        expect(() => requireValidGroupMutationCommand(command)).not.toThrow();
    });

    it('normalizes a supplied preset into a complete policy', () => {
        const command = toCreateCommand({ preset: 'managed' });

        expect(command.input.lifecyclePolicy).toEqual(resolveGroupLifecyclePolicyPreset('managed'));
    });

    it('layers sparse overrides over the preset', () => {
        const command = toCreateCommand({
            preset: 'managed',
            admission: { mode: 'closed' }
        });

        expect(command.input.lifecyclePolicy?.admission.mode).toBe('closed');
        expect(command.input.lifecyclePolicy?.formation).toBe('phased');
    });

    it('clamps an out-of-range knob rather than rejecting it', () => {
        const command = toCreateCommand({ activation: { successRate: 4 } });

        expect(command.input.lifecyclePolicy?.activation.successRate).toBe(1);
    });

    it('accepts a normalized policy through the structural validator', () => {
        const command = toCreateCommand({ preset: 'match' });

        expect(() => requireValidGroupMutationCommand(command)).not.toThrow();
    });
});

function requireValidGroupMutationCommand(command: unknown): void {
    const issues = validateGroupMutationCommand(command);
    if (issues.length > 0) {
        throw issues[0].cause;
    }
}
