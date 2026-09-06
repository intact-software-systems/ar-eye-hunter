import { APP_OUTBOX_FORMATION_TIMER_TOPIC } from '@shared-server/rallar-system/group-state/formation-timer-outbox-entry.ts';
import { validateGroupMutation } from '@shared-server/rallar-system/group-state/mutation/state-validation/validate-group-mutation.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecyclePolicy, GroupTopologyReconfigureLanding } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { describe, expect, it } from 'vitest';

import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationComputedWrite,
    GroupMutationFacts,
    GroupMutationRead
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { GroupConnectDeniedError } from '@shared-server/rallar-system/group-state/mutation/group-mutation-rejection-codes.ts';
import { toGroupMutationRejectionError } from '@shared-server/rallar-system/group-state/mutation/group-mutation-result.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import type { Group } from '@shared/api/group-types.ts';

import {
    createGroupAuthorityFacts,
    createGroupAuthorityRead,
    groupRef,
    transitionCommand,
    type GroupAuthorityReadOptions
} from './group-mutation-test-runtime.ts';

function writtenMutation(
    computed: GroupMutationComputed
): GroupMutationComputedWrite {
    if (computed.outcome !== 'write') {
        throw new Error(`Expected mutation write, received ${computed.outcome}`);
    }
    return computed;
}

function reconfigureCommand(
    landing: GroupTopologyReconfigureLanding
): Extract<GroupMutationCommand, { operation: 'reconfigureGroup'; }> {
    const command = transitionCommand('reconfigureGroup');
    if (command.operation !== 'reconfigureGroup') {
        throw new TypeError('Expected a reconfigure command');
    }
    return {
        ...command,
        input: { ...command.input, landing }
    };
}

function expectReconfigureLandingOverride(
    policy: GroupLifecyclePolicy | null,
    landing: GroupTopologyReconfigureLanding,
    lifecycleState: Group['lifecycleState']
): void {
    const read = createGroupAuthorityRead({ lifecycleState: 'active', formationEpoch: 4 });
    const computed = computeGroupMutation({
        command: reconfigureCommand(landing),
        read: {
            ...read,
            lifecyclePolicy: policy === null ? read.lifecyclePolicy : { status: 'present', policy }
        },
        facts: createGroupAuthorityFacts()
    });

    expect(computed.outcome).toBe('write');
    expect((writtenMutation(computed).guard.value as Group).lifecycleState).toBe(lifecycleState);
}

describe('group lifecycle transition computation', () => {
    it('computes a hold landing and its commanded topology replan', () => {
        const read = createGroupAuthorityRead({ lifecycleState: 'active', formationEpoch: 4 });
        const computed = computeGroupMutation({
            command: transitionCommand('reconfigureGroup'),
            read: {
                ...read,
                lifecyclePolicy: {
                    status: 'present',
                    policy: resolveGroupLifecyclePolicyPreset('match')
                }
            },
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
        const written = writtenMutation(computed);
        expect((written.guard.value as Group).lifecycleState).toBe('reconfiguring');
        const summaryMessage = JSON.parse(written.outboxWrites[0]!.entry.resource);
        expect(JSON.parse(summaryMessage.payload.resource)).toMatchObject({
            data: { event: { payload: { topologyReplanOrigin: 'commanded' } } }
        });
    });

    it('keeps an optimistic-policy group active for the apply landing while commanding its replan', () => {
        const computed = computeGroupMutation({
            command: transitionCommand('reconfigureGroup'),
            read: createGroupAuthorityRead({ lifecycleState: 'active', formationEpoch: 4 }),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
        const written = writtenMutation(computed);
        expect((written.guard.value as Group).lifecycleState).toBe('active');
        expect((written.guard.value as Group).formationEpoch).toBe(4);
        expect(written.outboxWrites).toHaveLength(1);
    });

    it.each(
        [
            { description: 'hold policy to apply', policy: resolveGroupLifecyclePolicyPreset('match'), landing: 'apply', lifecycleState: 'active' },
            { description: 'optimistic default to hold', policy: null, landing: 'hold', lifecycleState: 'reconfiguring' }
        ] as const
    )(
        'lets a reconfigure landing override $description',
        ({ policy, landing, lifecycleState }) => expectReconfigureLandingOverride(policy, landing, lifecycleState)
    );

    it('plans from forming into the planned stage and advances the epoch', () => {
        const computed = computeGroupMutation({
            command: transitionCommand('planGroupLayout'),
            read: createGroupAuthorityRead({ lifecycleState: 'forming', formationEpoch: 2 }),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        const written = computed.guard.value as Group;
        expect(written.lifecycleState).toBe('planned');
        expect(written.formationEpoch).toBe(3);
        expect(written.formationElectorate).toEqual(['alice']);
        // Planning stays with the transition's unconditional follow-up.
        expect(written.establishmentStartedAtEpochMs).toBe(null);
    });

    it('replans idempotently from planned: a write that re-pins nothing (decision 28)', () => {
        const computed = computeGroupMutation({
            command: transitionCommand('planGroupLayout'),
            read: createGroupAuthorityRead({
                lifecycleState: 'planned',
                formationEpoch: 4,
                formationElectorate: ['pinned-earlier']
            }),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        const written = computed.guard.value as Group;
        expect(written.lifecycleState).toBe('planned');
        expect(written.formationEpoch).toBe(4);
        expect(written.formationElectorate).toEqual(['pinned-earlier']);
        expect(written.snapshotVersion).toBe(2);
    });

    it('connects from planned when the fence names the current planned layout (decision 32)', () => {
        const stored = { lifecycleState: 'planned', formationEpoch: 4 } as const;
        const computed = computeGroupMutation({
            command: connectCommand({ expectedFormationEpoch: 4, expectedLayout: PLANNED_LAYOUT }),
            read: connectRead(stored, PLANNED_LAYOUT),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        const written = computed.guard.value as Group;
        expect(written.lifecycleState).toBe('connecting');
        expect(written.formationEpoch).toBe(5);
        expect(written.establishmentStartedAtEpochMs).toBe(2_000);
        // Dialing a candidate is not acceptance (decision 42).
        expect(written.acceptedLayoutIdentity).toBe(null);
    });

    it('carries the planned row into the write so a replan between read and commit conflicts', () => {
        const computed = computeGroupMutation({
            command: connectCommand({ expectedFormationEpoch: 4, expectedLayout: PLANNED_LAYOUT }),
            read: connectRead({ lifecycleState: 'planned', formationEpoch: 4 }, PLANNED_LAYOUT),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        // The revision is what the guarded batch asserts at commit.
        expect(computed.plannedLayoutFence?.revision).toBe(5);
        expect(computed.plannedLayoutFence?.snapshot).toEqual(plannedSnapshotFor(PLANNED_LAYOUT));
    });

    it('leaves the commit guard to the promotion when the transition promotes', () => {
        const computed = computeGroupMutation({
            command: criterionCommand('activateGroup', {
                observedRate: 1,
                expectedFormationEpoch: 5,
                expectedLayout: PLANNED_LAYOUT
            }),
            read: criterionRead({ lifecycleState: 'connecting', formationEpoch: 5 }),
            facts: criterionFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        // Activation's promotion emits the same guard itself; a second one
        // would assert the row twice in one batch.
        expect(computed.plannedLayoutFence).toBe(null);
        expect(computed.acceptedLayoutPromotion).not.toBe(null);
    });

    it.each(
        [
            { denial: 'stale-epoch', expectedFormationEpoch: 3, storedIdentity: PLANNED_LAYOUT },
            { denial: 'no-planned-layout', expectedFormationEpoch: 4, storedIdentity: null },
            {
                denial: 'planned-layout-superseded',
                expectedFormationEpoch: 4,
                storedIdentity: { ...PLANNED_LAYOUT, version: PLANNED_LAYOUT.version + 1 }
            }
        ] as const
    )('rejects a $denial connect with its own conflict code', (row) => {
        const computed = computeGroupMutation({
            command: connectCommand({ expectedFormationEpoch: row.expectedFormationEpoch, expectedLayout: PLANNED_LAYOUT }),
            read: connectRead({ lifecycleState: 'planned', formationEpoch: 4 }, row.storedIdentity),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('rejected');
        if (computed.outcome !== 'rejected') {
            return;
        }
        expect(computed.rejectionCode).toBe(`group-connect-${row.denial}`);
        // The handler boundary maps the code to its own 409 conflict.
        const error = toGroupMutationRejectionError(computed);
        expect(error).toBeInstanceOf(GroupConnectDeniedError);
        expect((error as GroupConnectDeniedError).status).toBe(409);
        expect((error as GroupConnectDeniedError).code).toBe(`group-connect-${row.denial}`);
    });

    it('rejects a connect fence that names a removed layout', () => {
        const removed = { ...PLANNED_LAYOUT, state: 'removed' } as const;
        const computed = computeGroupMutation({
            command: connectCommand({ expectedFormationEpoch: 4, expectedLayout: removed }),
            read: connectRead({ lifecycleState: 'planned', formationEpoch: 4 }, removed),
            facts: createGroupAuthorityFacts()
        });
        expect(computed.outcome).toBe('rejected');
    });

    it('publishes planning intent and advances the formation epoch', () => {
        const computed = computeGroupMutation({
            command: transitionCommand('planGroupLayout'),
            read: createGroupAuthorityRead({ lifecycleState: 'forming', formationEpoch: 2 }),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        expect(computed.guard.kind).toBe('group');
        const written = computed.guard.value as Group;
        expect(written.lifecycleState).toBe('planned');
        expect(written.formationEpoch).toBe(3);
        expect(written.snapshotVersion).toBe(2);
        expect(computed.event.eventType).toBe('group-updated');
    });

    it('pins the formation electorate to the roster read at every epoch advance', () => {
        const cases = [
            { operation: 'planGroupLayout', lifecycleState: 'forming' },
            { operation: 'activateGroup', lifecycleState: 'connecting' },
            { operation: 'reconfigureGroup', lifecycleState: 'active' }
        ] as const;
        for (const { operation, lifecycleState } of cases) {
            const computed = computeGroupMutation({
                command: transitionCommand(operation),
                read: operation === 'activateGroup' ? connectRead({ lifecycleState }, PLANNED_LAYOUT) : createGroupAuthorityRead({ lifecycleState }),
                facts: createGroupAuthorityFacts()
            });
            expect(computed.outcome).toBe('write');
            if (computed.outcome !== 'write') {
                continue;
            }
            // createGroupAuthorityRead loads the actor as the only active member.
            expect((computed.guard.value as Group).formationElectorate).toEqual(['alice']);
        }
    });

    it.each(
        [
            { stage: 'connecting', plan: null },
            { stage: 'reconnecting', plan: null },
            { stage: 'connecting', plan: { ...PLANNED_LAYOUT, state: 'removed' } },
            { stage: 'reconnecting', plan: { ...PLANNED_LAYOUT, state: 'removed' } }
        ] as const
    )('rejects manual activation without a live planned layout in $stage', ({ stage, plan }) => {
        const computed = computeGroupMutation({
            command: transitionCommand('activateGroup'),
            read: connectRead({ lifecycleState: stage, formationEpoch: 1 }, plan),
            facts: createGroupAuthorityFacts()
        });
        expect(computed).toMatchObject({ outcome: 'rejected', receipt: { eventId: null, outboxIds: [] } });
        expect('guard' in computed).toBe(false);
        expect('acceptedLayoutPromotion' in computed).toBe(false);
    });

    it('activates only after initial or replacement dialing and canonically promotes the planned layout', () => {
        for (const from of ['connecting', 'reconnecting'] as const) {
            const computed = computeGroupMutation({
                command: transitionCommand('activateGroup'),
                read: connectRead({ lifecycleState: from, formationEpoch: 1 }, PLANNED_LAYOUT),
                facts: createGroupAuthorityFacts()
            });
            expect(computed.outcome).toBe('write');
            if (computed.outcome !== 'write') {
                continue;
            }
            const written = computed.guard.value as Group;
            expect(written.lifecycleState).toBe('active');
            expect(written.formationEpoch).toBe(2);
            expect(written.acceptedLayoutIdentity).toEqual(PLANNED_LAYOUT);
            expect(computed.acceptedLayoutPromotion?.acceptedSnapshot).toEqual(plannedSnapshotFor(PLANNED_LAYOUT));
        }
    });

    it('holds the replacement layout when explicitly commanded', () => {
        const computed = computeGroupMutation({
            command: reconfigureCommand('hold'),
            read: createGroupAuthorityRead({ lifecycleState: 'active', formationEpoch: 4 }),
            facts: createGroupAuthorityFacts()
        });
        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        const written = computed.guard.value as Group;
        expect(written.lifecycleState).toBe('reconfiguring');
        expect(written.formationEpoch).toBe(5);
    });

    it('denies an illegal transition as a typed policy denial', () => {
        expect(
            computeGroupMutation({
                command: transitionCommand('planGroupLayout'),
                read: createGroupAuthorityRead({ lifecycleState: 'active', formationEpoch: 1 }),
                facts: createGroupAuthorityFacts()
            })
        ).toMatchObject({ outcome: 'rejected', rejectionCode: 'group-policy-denied' });
    });

    it('validates a serialized policy denial and rejects a changed denial message', () => {
        const command = transitionCommand('planGroupLayout');
        const read = createGroupAuthorityRead({ lifecycleState: 'active', formationEpoch: 1 });
        const facts = createGroupAuthorityFacts();
        const computed = computeGroupMutation({ command, read, facts });
        expect(computed).toMatchObject({ outcome: 'rejected', rejectionCode: 'group-policy-denied' });
        const serialized: GroupMutationComputed = JSON.parse(JSON.stringify(computed));
        expect(validateGroupMutation({ command, read, facts, computed: serialized })).toEqual([]);
        if (computed.outcome !== 'rejected' || computed.rejectionCode !== 'group-policy-denied') {
            throw new Error('Expected a policy rejection');
        }
        expect(
            validateGroupMutation({
                command,
                read,
                facts,
                computed: { ...computed, policyDenial: { ...computed.policyDenial, message: 'forged denial' } }
            }).map((issue) => issue.path)
        ).toContain('computed.policyDenial.message');
    });

    it('denies a non-manager under the managed policy', () => {
        const read = createGroupAuthorityRead(
            { lifecycleState: 'forming', formationEpoch: 0, ownerPrincipalId: 'owner-alice' },
            { policy: 'managed', actorPrincipalId: 'bob' }
        );
        expect(
            computeGroupMutation({
                command: transitionCommand('planGroupLayout', 'bob'),
                read,
                facts: createGroupAuthorityFacts('bob')
            })
        ).toMatchObject({ outcome: 'rejected', rejectionCode: 'group-policy-denied' });
    });

    it('rejects on a corrupt stored policy instead of failing open', () => {
        const computed = computeGroupMutation({
            command: transitionCommand('planGroupLayout'),
            read: createGroupAuthorityRead({ lifecycleState: 'forming', formationEpoch: 0 }, { policy: 'corrupt' }),
            facts: createGroupAuthorityFacts()
        });
        expect(computed.outcome).toBe('rejected');
    });

    // The landing is the attempt budget's, not the table's: the series' last
    // attempt parks the group in `dormant` (product decisions 35 and 37),
    // where a closed lobby stays closed (product decision 38) and nothing
    // re-arms; an unexhausted failure follows the table.
    it.each(
        [
            { label: 'an unexhausted dial returns to forming', from: 'connecting', policy: 'managed', attempts: 1, landing: 'forming' },
            { label: 'the last dial parks in dormant', from: 'connecting', policy: 'optimistic', attempts: 0, landing: 'dormant' },
            { label: 'an unexhausted reconnect returns to active', from: 'reconnecting', policy: 'managed', attempts: 1, landing: 'active' },
            { label: 'the last reconnect parks in dormant', from: 'reconnecting', policy: 'optimistic', attempts: 0, landing: 'dormant' }
        ] as const
    )('fails formation with criterion authority: $label', (row) => {
        const computed = computeGroupMutation({
            command: criterionCommand('failGroupFormation', {
                observedRate: 0.3,
                expectedFormationEpoch: 2,
                expectedLayout: PLANNED_LAYOUT
            }),
            read: criterionRead(
                {
                    lifecycleState: row.from,
                    formationEpoch: 2,
                    establishmentStartedAtEpochMs: 1_500,
                    formationAttemptCount: row.attempts,
                    transportState: 'flowing'
                },
                PLANNED_LAYOUT,
                { policy: row.policy }
            ),
            facts: criterionFacts()
        });
        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        const written = computed.guard.value as Group;
        expect(written.lifecycleState).toBe(row.landing);
        expect(written.formationEpoch).toBe(3);
        expect(written.formationAttemptCount).toBe(row.attempts + 1);
        expect(written.establishmentStartedAtEpochMs).toBe(null);
        // The valve is `reset`'s to close (product decision 36); every
        // transition carries it through unchanged.
        expect(written.transportState).toBe('flowing');
        expect(written.lastFormationOutcome).toEqual({
            outcome: 'below-floor',
            observedRate: 0.3,
            atEpochMs: 2_000,
            formationEpoch: 2
        });
    });

    // The retry leg is armed by the `forming` landing, so parking is what
    // disarms it: the same failure one attempt earlier still schedules the
    // next one.
    it.each([
        { label: 'an unexhausted failure arms the next attempt', attempts: 1, landing: 'forming', timers: 1 },
        { label: 'the parked series arms nothing', attempts: 2, landing: 'dormant', timers: 0 }
    ])('$label', (row) => {
        const computed = computeGroupMutation({
            command: criterionCommand('failGroupFormation', {
                observedRate: 0,
                expectedFormationEpoch: 2,
                expectedLayout: PLANNED_LAYOUT
            }),
            read: criterionRead(
                { lifecycleState: 'connecting', formationEpoch: 2, formationAttemptCount: row.attempts },
                PLANNED_LAYOUT,
                { policy: 'managed' }
            ),
            facts: criterionFacts()
        });
        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        expect((computed.guard.value as Group).lifecycleState).toBe(row.landing);
        expect(
            computed.outboxWrites.filter(
                (write) => write.entry.key.topicId === APP_OUTBOX_FORMATION_TIMER_TOPIC
            )
        ).toHaveLength(row.timers);
    });

    // The causal fence: a stale petition is a typed rejection that computes
    // no write facts at all — never a wrong transition, never a silent no-op.

    it.each([
        {
            label: 'a stale epoch',
            expectedFormationEpoch: 1,
            expectedLayout: PLANNED_LAYOUT,
            planned: PLANNED_LAYOUT,
            rejection: /stale-epoch/
        },
        {
            label: 'a superseded planned layout',
            expectedFormationEpoch: 2,
            expectedLayout: { ...PLANNED_LAYOUT, version: 1 },
            planned: PLANNED_LAYOUT,
            rejection: /planned-layout-superseded/
        },
        {
            label: 'a missing planned row',
            expectedFormationEpoch: 2,
            expectedLayout: PLANNED_LAYOUT,
            planned: null,
            rejection: /no-planned-layout/
        }
    ])('fences $label without computing any write', (row) => {
        const computed = computeGroupMutation({
            command: criterionCommand('failGroupFormation', {
                observedRate: 0.3,
                expectedFormationEpoch: row.expectedFormationEpoch,
                expectedLayout: row.expectedLayout
            }),
            read: criterionRead(
                { lifecycleState: 'connecting', formationEpoch: 2 },
                row.planned
            ),
            facts: criterionFacts()
        });
        expect(computed.outcome).toBe('rejected');
        if (computed.outcome !== 'rejected') {
            return;
        }
        expect(computed.receipt.rejection).toMatch(row.rejection);
        // Only `connect` earns the conflict codes; a criterion petition keeps the shared rejection.
        expect(computed.rejectionCode).toBe('group-mutation-rejected');
        expect(computed.receipt.eventId).toBeNull();
        expect(computed.receipt.outboxIds).toEqual([]);
        expect('guard' in computed).toBe(false);
        expect('outboxEntries' in computed).toBe(false);
    });

    it('rejects principal-commanded formation failure', () => {
        // Key-complete on purpose: the command survives input validation so
        // the compute-level principal ban is what rejects it.
        const principalFail = {
            operation: 'failGroupFormation',
            aggregateRef: groupRef('pure-room'),
            commandId: 'lifecycle-command',
            requestId: 'lifecycle-command',
            input: {
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                reason: null,
                traceId: null,
                observedRate: 0.2,
                expectedFormationEpoch: null,
                expectedLayout: null
            }
        } as GroupMutationCommand;
        expect(
            computeGroupMutation({
                command: principalFail,
                read: createGroupAuthorityRead({ lifecycleState: 'connecting', formationEpoch: 1 }),
                facts: createGroupAuthorityFacts()
            })
        ).toMatchObject({
            outcome: 'rejected',
            rejectionCode: 'group-mutation-rejected',
            receipt: { rejection: 'Formation failure is criterion-commanded only' }
        });
    });

    it('records the criterion outcome on internal activation', () => {
        for (
            const [degraded, outcome] of [
                [false, 'activated'],
                [true, 'activated-degraded']
            ] as const
        ) {
            const computed = computeGroupMutation({
                command: criterionCommand('activateGroup', {
                    observedRate: 0.97,
                    degraded,
                    expectedFormationEpoch: 1,
                    expectedLayout: PLANNED_LAYOUT
                }),
                read: criterionRead({ lifecycleState: 'connecting', formationEpoch: 1 }),
                facts: criterionFacts()
            });
            expect(computed.outcome).toBe('write');
            if (computed.outcome !== 'write') {
                continue;
            }
            const written = computed.guard.value as Group;
            expect(written.lifecycleState).toBe('active');
            expect(written.lastFormationOutcome).toMatchObject({ outcome, observedRate: 0.97 });
        }
    });

    it('leaves the recorded outcome untouched on manual activation', () => {
        const computed = computeGroupMutation({
            command: transitionCommand('activateGroup'),
            read: connectRead({ lifecycleState: 'connecting', formationEpoch: 1 }, PLANNED_LAYOUT),
            facts: createGroupAuthorityFacts()
        });
        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        expect((computed.guard.value as Group).lastFormationOutcome).toBe(null);
    });

    it('fails closed when a current group has no lifecycle policy row', () => {
        const computed = computeGroupMutation({
            command: transitionCommand('planGroupLayout'),
            read: createGroupAuthorityRead({ lifecycleState: 'forming', formationEpoch: 0 }, { policy: 'absent' }),
            facts: createGroupAuthorityFacts()
        });
        expect(computed).toMatchObject({
            outcome: 'rejected',
            receipt: { rejection: 'Group lifecycle policy is unreadable: Group lifecycle policy is missing' }
        });
    });
});

const PLANNED_LAYOUT = {
    groupRevision: 6,
    presenceRevision: 9,
    version: 2,
    state: 'active'
} as const;

// The row carries only the snapshot; the identity is derived from it, so the
// fixture builds a snapshot whose derived identity is exactly the requested
// one — a mismatched pair cannot be spelled.
function plannedSnapshotFor(identity: GroupLayoutIdentity): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: identity.groupRevision,
            presenceRevision: identity.presenceRevision
        },
        state: identity.state,
        overlayId: toScopedOverlayId(groupRef('pure-room')),
        groupRef: groupRef('pure-room'),
        name: 'pure-room-overlay',
        topology: 'tree',
        activeSessionIds: [],
        nextHopsBySessionId: {},
        degreeLimit: 2,
        version: identity.version,
        createdByClientId: 'lifecycle-test',
        createdAtEpochMs: 900,
        updatedAtEpochMs: 950
    };
}

function connectCommand(
    extras: Readonly<{ expectedFormationEpoch: number; expectedLayout: GroupLayoutIdentity; }>
): GroupMutationCommand {
    return {
        operation: 'connectGroup',
        aggregateRef: groupRef('pure-room'),
        commandId: 'connect-command',
        requestId: 'connect-command',
        input: {
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            reason: null,
            traceId: null,
            expectedFormationEpoch: extras.expectedFormationEpoch,
            expectedLayout: extras.expectedLayout,
            connectTriggerGeneration: null
        }
    } as GroupMutationCommand;
}

function connectRead(
    groupOverrides: Partial<Group>,
    plannedLayoutIdentity: GroupLayoutIdentity | null
): GroupMutationRead {
    return {
        ...createGroupAuthorityRead(groupOverrides),
        plannedLayoutRow: plannedLayoutIdentity === null ? null : {
            snapshot: plannedSnapshotFor(plannedLayoutIdentity),
            revision: 5
        },
        acceptedLayoutRow: null
    } as GroupMutationRead;
}

function criterionRead(
    groupOverrides: Partial<Group>,
    plannedLayoutIdentity: GroupLayoutIdentity | null = PLANNED_LAYOUT,
    options: GroupAuthorityReadOptions = {}
): GroupMutationRead {
    return {
        ...createGroupAuthorityRead(groupOverrides, options),
        actorMember: null,
        actorMemberEntry: null,
        plannedLayoutRow: plannedLayoutIdentity === null ? null : {
            snapshot: plannedSnapshotFor(plannedLayoutIdentity),
            revision: 5
        },
        acceptedLayoutRow: null
    } as GroupMutationRead;
}

function criterionCommand(
    operation: 'activateGroup' | 'failGroupFormation',
    extras: Readonly<{
        observedRate: number;
        degraded?: boolean;
        expectedFormationEpoch?: number;
        expectedLayout?: GroupLayoutIdentity;
    }>
): GroupMutationCommand {
    return {
        operation,
        aggregateRef: groupRef('pure-room'),
        commandId: 'criterion-command',
        requestId: 'criterion-command',
        input: {
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null,
            observedRate: extras.observedRate,
            expectedFormationEpoch: extras.expectedFormationEpoch ?? null,
            expectedLayout: extras.expectedLayout ?? null,
            ...(operation === 'activateGroup' ? { degraded: extras.degraded ?? false } : {})
        }
    } as GroupMutationCommand;
}

function criterionFacts(): GroupMutationFacts {
    return {
        ...createGroupAuthorityFacts(),
        internalAuthority: 'formation-criterion',
        authenticatedAuthority: null
    };
}
