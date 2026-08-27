import { describe, expect, it } from 'vitest';

import {
    toFailFormationCommand,
    toFormationActivateCommand,
    toFormationRetryEstablishCommand
} from '@shared-server/rallar-system/group-state/group-formation-mutation-command.ts';
import type {
    GroupMutationCommand,
    GroupMutationFacts
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { validateGroupMutationAuthority } from '@shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-authority.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';

const GROUP_REF = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' } as const;

const LAYOUT_A: GroupLayoutIdentity = {
    groupRevision: 4,
    presenceRevision: 7,
    version: 2,
    state: 'active'
};

const LAYOUT_B: GroupLayoutIdentity = { ...LAYOUT_A, groupRevision: 5, version: 3 };

function internalFacts(mode: GroupMutationFacts['internalAuthority']): GroupMutationFacts {
    return {
        nowEpochMs: 1_000,
        expireAtEpochMs: 100_000,
        attemptCount: 1,
        serviceId: 'server-1',
        eventId: 'group-event:test',
        commandHash: `sha256:${'a'.repeat(64)}`,
        resolvedJoinCode: null,
        joinCodeVerifier: null,
        internalAuthority: mode,
        authenticatedAuthority: null
    };
}

function internalJoinCommand(): GroupMutationCommand {
    return {
        operation: 'joinGroup',
        aggregateRef: GROUP_REF,
        targetPrincipalId: 'alice',
        commandId: 'join-1',
        requestId: 'join-1',
        input: {
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null,
            inviteToken: null,
            joinCode: null
        }
    };
}

describe('internal authority capability matrix', () => {
    it('accepts a fully fenced criterion activation', () => {
        const command = toFormationActivateCommand({
            groupRef: GROUP_REF,
            formationEpoch: 3,
            observedRate: 0.95,
            degraded: false,
            expectedLayout: LAYOUT_A
        });

        expect(() => validateGroupMutationAuthority(command, internalFacts('formation-criterion')))
            .not.toThrow();
    });

    it('fails formation-criterion closed outside its three transitions', () => {
        expect(() =>
            validateGroupMutationAuthority(internalJoinCommand(), internalFacts('formation-criterion'))
        ).toThrow('limited to criterion transitions');
    });

    // The three modes registered ahead of their operations admit nothing:
    // every cross-product outside the capability table fails closed.
    it.each([
        { mode: 'formation-automation' as const, message: 'automatic stage commands' },
        { mode: 'topology-publication' as const, message: 'applyPlannedLayout' },
        { mode: 'activation-status' as const, message: 'status update' }
    ])('fails $mode closed on every current operation', (row) => {
        expect(() => validateGroupMutationAuthority(internalJoinCommand(), internalFacts(row.mode)))
            .toThrow(row.message);
        const criterionShaped = toFormationRetryEstablishCommand({
            groupRef: GROUP_REF,
            formationEpoch: 2
        });
        expect(() => validateGroupMutationAuthority(criterionShaped, internalFacts(row.mode)))
            .toThrow(row.message);
    });

    it('rejects an internal command claiming a semantic actor', () => {
        const command = {
            ...internalJoinCommand(),
            input: { ...internalJoinCommand().input, actorPrincipalId: 'alice' }
        } as GroupMutationCommand;

        expect(() => validateGroupMutationAuthority(command, internalFacts('formation-criterion')))
            .toThrow('cannot claim semantic actor authority');
    });

    it('rejects internal authority combined with authenticated authority', () => {
        const facts: GroupMutationFacts = {
            ...internalFacts('formation-criterion'),
            authenticatedAuthority: { principalId: 'alice', sessionId: 'session-1' }
        };
        const command = toFormationRetryEstablishCommand({ groupRef: GROUP_REF, formationEpoch: 1 });

        expect(() => validateGroupMutationAuthority(command, facts))
            .toThrow('cannot use authenticated authority facts');
    });

    // The fence is mandatory on internal commands: a fence-less criterion
    // petition is malformed, not merely unfenced.
    it('requires the fence fields on criterion commands', () => {
        const unfenced = {
            ...toFormationActivateCommand({
                groupRef: GROUP_REF,
                formationEpoch: 3,
                observedRate: 0.95,
                degraded: false,
                expectedLayout: LAYOUT_A
            })
        } as GroupMutationCommand & { input: Record<string, unknown>; };
        const withoutLayout = {
            ...unfenced,
            input: { ...unfenced.input, expectedLayout: null }
        } as GroupMutationCommand;
        const withoutEpoch = {
            ...unfenced,
            input: { ...unfenced.input, expectedFormationEpoch: null }
        } as GroupMutationCommand;

        expect(() => validateGroupMutationAuthority(withoutLayout, internalFacts('formation-criterion')))
            .toThrow('expected layout fence');
        expect(() => validateGroupMutationAuthority(withoutEpoch, internalFacts('formation-criterion')))
            .toThrow('expected formation epoch fence');
    });
});

describe('criterion request identity v2', () => {
    it('keys the command id on the full fence, layout identity included', () => {
        const base = {
            groupRef: GROUP_REF,
            formationEpoch: 3,
            observedRate: 0.95,
            degraded: false
        };
        const againstA = toFormationActivateCommand({ ...base, expectedLayout: LAYOUT_A });
        const againstB = toFormationActivateCommand({ ...base, expectedLayout: LAYOUT_B });

        expect(againstA.commandId).toContain('formation-criterion:v2:activate:');
        expect(againstA.commandId).not.toBe(againstB.commandId);
        expect(againstA.requestId).toBe(againstA.commandId);
    });

    it('keeps identical fences replay-identical', () => {
        const build = () =>
            toFailFormationCommand({
                groupRef: GROUP_REF,
                formationEpoch: 2,
                observedRate: 0.3,
                expectedLayout: LAYOUT_A
            });

        expect(build().commandId).toBe(build().commandId);
    });

    it('binds the retry leg to the epoch alone', () => {
        const command = toFormationRetryEstablishCommand({ groupRef: GROUP_REF, formationEpoch: 4 });

        expect(command.commandId).toContain('formation-criterion:v2:retry-establish:');
        if (command.operation !== 'startGroupEstablishment') {
            throw new Error('retry command must target startGroupEstablishment');
        }
        expect(command.input.expectedFormationEpoch).toBe(4);
    });
});
