import { describe, expect, it } from 'vitest';

import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { materializeGroupStateGuardedBatch } from '@shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { Group } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import { createGroupAuthorityFacts, createGroupAuthorityRead, groupRef } from './group-mutation-test-runtime.ts';

/**
 * The formation series' two ends (product decisions 35-37): `start` opens a
 * series from the clean slate, `reset` returns to it. Both are dark — no
 * route, no producer — until slice 8 mounts them.
 */
describe('group formation series computation', () => {
    it('starts a new series from dormant and advances the epoch', () => {
        const computed = computeGroupMutation({
            command: seriesCommand('startGroupFormation'),
            read: createGroupAuthorityRead({ lifecycleState: 'dormant', formationEpoch: 4 }),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        const written = computed.guard.value as Group;
        expect(written.lifecycleState).toBe('forming');
        expect(written.formationEpoch).toBe(5);
    });

    // Decision 37: exhaustion is terminal for automation, and only an explicit
    // `reset` clears the series. The optimistic preset allows one attempt.
    it('denies start while the attempt series is exhausted', () => {
        expect(() =>
            computeGroupMutation({
                command: seriesCommand('startGroupFormation'),
                read: createGroupAuthorityRead({
                    lifecycleState: 'dormant',
                    formationAttemptCount: 1
                }, { policy: 'optimistic' }),
                facts: createGroupAuthorityFacts()
            })
        ).toThrowError(GroupPolicyDeniedError);
    });

    it('starts while the series still has budget', () => {
        const computed = computeGroupMutation({
            command: seriesCommand('startGroupFormation'),
            read: createGroupAuthorityRead({
                lifecycleState: 'dormant',
                formationAttemptCount: 0
            }, { policy: 'optimistic' }),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
    });

    // Product decision 36: one transaction returns the group to the clean
    // slate. Membership, topology config and overrides are deliberately left
    // alone; everything the formation series owns is cleared.
    it('clears the whole formation series and halts transport', () => {
        const computed = computeGroupMutation({
            command: seriesCommand('resetGroupFormation'),
            read: createGroupAuthorityRead({
                lifecycleState: 'active',
                formationEpoch: 7,
                formationAttemptCount: 3,
                establishmentStartedAtEpochMs: 1_500,
                transportState: 'flowing',
                acceptedLayoutIdentity: {
                    groupRevision: 6,
                    presenceRevision: 9,
                    version: 2,
                    state: 'active'
                },
                lastFormationOutcome: {
                    outcome: 'below-floor',
                    observedRate: 0.25,
                    atEpochMs: 900,
                    formationEpoch: 6
                }
            }),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        const written = computed.guard.value as Group;
        expect(written.lifecycleState).toBe('dormant');
        expect(written.formationEpoch).toBe(8);
        expect(written.formationAttemptCount).toBe(0);
        expect(written.establishmentStartedAtEpochMs).toBe(null);
        expect(written.lastFormationOutcome).toBe(null);
        expect(written.acceptedLayoutIdentity).toBe(null);
        expect(written.transportState).toBe('halted');
        // Decision 36 keeps membership and its counts out of the reset.
        expect(written.activeMemberCount).toBe(1);
    });

    it('resets from any stage, not only the failed ones', () => {
        for (const lifecycleState of ['forming', 'planned', 'connecting', 'reconfiguring'] as const) {
            const computed = computeGroupMutation({
                command: seriesCommand('resetGroupFormation'),
                read: createGroupAuthorityRead({ lifecycleState, transportState: 'flowing' }),
                facts: createGroupAuthorityFacts()
            });

            expect(computed.outcome, lifecycleState).toBe('write');
            if (computed.outcome !== 'write') {
                return;
            }
            expect((computed.guard.value as Group).lifecycleState, lifecycleState).toBe('dormant');
        }
    });

    // Product decision 36: both topology slots are tombstoned in the same
    // transaction. A tombstone rather than a delete, because the fingerprints
    // stay valid for tracing and a physical delete would destroy the evidence.
    it('tombstones both layout rows under their own revisions', () => {
        const computed = computeGroupMutation({
            command: seriesCommand('resetGroupFormation'),
            read: {
                ...createGroupAuthorityRead({ lifecycleState: 'active' }),
                plannedLayoutRow: { snapshot: layoutSnapshot('active', 2), revision: 5 },
                acceptedLayoutRow: { snapshot: layoutSnapshot('active', 1), revision: 3 }
            },
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        // A removed row may carry no edge — the persisted decoder rejects one
        // that does — so the sessions survive with their hops emptied.
        const retired = (version: number) => ({
            ...layoutSnapshot('active', version),
            state: 'removed' as const,
            nextHopsBySessionId: { 'session-a': [], 'session-b': [] }
        });
        expect(computed.layoutTombstones).toEqual({
            planned: { snapshot: retired(2), revision: 5 },
            accepted: { snapshot: retired(1), revision: 3 }
        });
    });

    // Product decision 36 asks for one transaction. Reset's own part of that
    // is putting every write into a single guarded batch: the batch is what
    // commits or rolls back as a unit, so an effect left outside it would be
    // the one thing that could survive a failed reset.
    it('puts the group row and both tombstones in one guarded batch', () => {
        const batch = materializeGroupStateGuardedBatch(seriesResetComputed());

        expect(batch.guard.namespace).toContain('group');
        expect(batch.effects.map((effect) => effect.effectId)).toEqual(
            expect.arrayContaining(['planned-layout-tombstone', 'accepted-layout-tombstone'])
        );
        const tombstones = batch.effects.filter((effect) => effect.effectId.endsWith('-layout-tombstone'));
        // Each rewrites the row it read, under that row's revision, so a
        // concurrent publication conflicts the whole batch instead of losing.
        expect(tombstones.map((effect) => effect.operation)).toEqual(['update', 'update']);
        expect(
            tombstones.map((effect) => (effect.operation === 'update' ? effect.expectedRevision : null))
        ).toEqual([5, 3]);
    });

    // The clean slate has to work on a group that never planned anything.
    it('tombstones nothing when neither slot holds a row', () => {
        const computed = computeGroupMutation({
            command: seriesCommand('resetGroupFormation'),
            read: createGroupAuthorityRead({ lifecycleState: 'forming' }),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        expect(computed.layoutTombstones).toEqual({ planned: null, accepted: null });
    });
});

function seriesResetComputed() {
    const computed = computeGroupMutation({
        command: seriesCommand('resetGroupFormation'),
        read: {
            ...createGroupAuthorityRead({ lifecycleState: 'active' }),
            plannedLayoutRow: { snapshot: layoutSnapshot('active', 2), revision: 5 },
            acceptedLayoutRow: { snapshot: layoutSnapshot('active', 1), revision: 3 }
        },
        facts: createGroupAuthorityFacts()
    });
    if (computed.outcome !== 'write') {
        throw new Error('Reset must compute a write');
    }
    return computed;
}

function layoutSnapshot(state: 'active' | 'removed', version: number): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateCausalRevision: { groupRevision: 6, presenceRevision: 9 },
        state,
        overlayId: toScopedOverlayId(groupRef('pure-room')),
        groupRef: groupRef('pure-room'),
        name: 'pure-room-overlay',
        topology: 'tree',
        activeSessionIds: ['session-a', 'session-b'],
        nextHopsBySessionId: { 'session-a': ['session-b'], 'session-b': ['session-a'] },
        degreeLimit: 2,
        version,
        createdByClientId: 'series-test',
        createdAtEpochMs: 900,
        updatedAtEpochMs: 950
    };
}

function seriesCommand(
    operation: 'startGroupFormation' | 'resetGroupFormation',
    actorPrincipalId = 'alice'
): GroupMutationCommand {
    return {
        operation,
        aggregateRef: groupRef('pure-room'),
        commandId: 'series-command',
        requestId: 'series-command',
        input: {
            actorPrincipalId,
            actorSessionId: `${actorPrincipalId}-session`,
            reason: null,
            traceId: null,
            expectedFormationEpoch: null
        }
    } as GroupMutationCommand;
}
