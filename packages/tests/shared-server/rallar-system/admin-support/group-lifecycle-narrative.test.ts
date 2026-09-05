import { describe, expect, it } from 'vitest';

import { projectGroupAdminSupportNarrative } from '@shared-server/rallar-system/admin-support/narratives/project-group-admin-support-narrative.ts';
import type { AdminSupportJsonValue } from '@shared/api/admin-support/admin-support-types.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { createTestGroup } from '../../../create-test-group.ts';

const GROUP_REF = { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'room-1' };
const NOW = 1_000_000;

/**
 * The operator surface for the lifecycle plane (slice 13). These are the facts
 * a support engineer cannot get any other way: which stage the group is in,
 * which layout carries traffic, whether application data is flowing, and what
 * the group is telling its members about its own connectivity.
 */
describe('the group narrative reports the lifecycle plane', () => {
    it('names the stage, series, valve and accepted layout', () => {
        const facts = factsFor({
            lifecycleState: 'active',
            formationEpoch: 4,
            formationAttemptCount: 1,
            transportState: 'flowing',
            acceptedLayoutIdentity: { groupRevision: 9, presenceRevision: 2, version: 3, state: 'active' }
        });

        expect(facts['group.lifecycleState']).toBe('active');
        expect(facts['group.formationEpoch']).toBe(4);
        // The input the parked warning branches on; unasserted it could be
        // deleted without failing anything.
        expect(facts['group.formationAttemptCount']).toBe(1);
        expect(facts['group.transportState']).toBe('flowing');
        // The tuple, never a bare version (product decision 29), so two
        // identities can be told apart by a reader.
        expect(facts['group.acceptedLayoutIdentity']).toBe('active r9/2 v3');
    });

    it('reports an unconfirmed status as unavailable rather than inventing a band', () => {
        const narrative = narrativeFor({ activationStatus: null, acceptedLayoutIdentity: null });
        const byLabel = Object.fromEntries(narrative.facts.map((f) => [f.label, f]));

        for (
            const label of [
                'group.activationCondition',
                'group.activationCoverageRate',
                'group.activationStatusEpoch',
                'group.activationPublishedAtEpochMs'
            ]
        ) {
            expect(byLabel[label]?.value).toBe('unconfirmed');
            expect(byLabel[label]?.certainty).toBe('unavailable');
        }
        expect(byLabel['group.activationCoverageBasis']?.value).toBe('none');
        // An absent accepted layout is authoritatively absent, not a failed
        // lookup, but it is reported the same way the file already reports a
        // missing member or topology view.
        expect(byLabel['group.acceptedLayoutIdentity']?.value).toBe('none');
        expect(byLabel['group.acceptedLayoutIdentity']?.certainty).toBe('unavailable');
    });

    // A status from a spent series describes a layout the group has moved
    // past; it is still shown, because that staleness is often the thing
    // being debugged, but it must not be called exact.
    it('downgrades a status whose series the group has left', () => {
        const narrative = narrativeFor({
            formationEpoch: 6,
            activationStatus: {
                condition: 'active',
                coverageRate: 1,
                coverageBasisLayoutIdentity: {
                    groupRevision: 9,
                    presenceRevision: 2,
                    version: 3,
                    state: 'active'
                },
                formationEpoch: 4,
                evidenceWatermark: null,
                publishedAtEpochMs: NOW - 900
            }
        });
        const condition = narrative.facts.find((f) => f.label === 'group.activationCondition');

        expect(condition?.value).toBe('active');
        expect(condition?.certainty).toBe('inferred');
    });

    it('reports the published status the writer stored', () => {
        const narrative = narrativeFor({
            // Same series as the status, so it is current rather than stale.
            formationEpoch: 4,
            activationStatus: {
                condition: 'degraded',
                coverageRate: 0.6,
                coverageBasisLayoutIdentity: {
                    groupRevision: 9,
                    presenceRevision: 2,
                    version: 3,
                    state: 'active'
                },
                formationEpoch: 4,
                evidenceWatermark: { version: 11, createdAtEpochMs: NOW - 500 },
                publishedAtEpochMs: NOW - 100
            }
        });
        const byLabel = Object.fromEntries(narrative.facts.map((f) => [f.label, f]));

        expect(byLabel['group.activationCondition']?.value).toBe('degraded');
        expect(byLabel['group.activationCondition']?.certainty).toBe('exact');
        expect(byLabel['group.activationCoverageRate']?.value).toBe(0.6);
        expect(byLabel['group.activationCoverageBasis']?.value).toBe('active r9/2 v3');
        expect(byLabel['group.activationPublishedAtEpochMs']?.value).toBe(NOW - 100);
    });

    // The valve is only half the gate: under `blocked-until-active` the
    // forward gate composes with it, so `flowing` alone does not mean data
    // flows (product decision 25).
    it('reports the data gate, not just the valve', () => {
        const match = resolveGroupLifecyclePolicyPreset('match');

        expect(factsFor({ lifecycleState: 'connecting', transportState: 'flowing' }, match)['group.dataGate'])
            .toBe('blocked');
        expect(factsFor({ lifecycleState: 'active', transportState: 'flowing' }, match)['group.dataGate'])
            .toBe('flows');
        expect(factsFor({ lifecycleState: 'active', transportState: 'halted' }, match)['group.dataGate'])
            .toBe('halted');
    });

    it('reports the remediation axis as inferred, because it cannot see the planning fingerprint', () => {
        const narrative = narrativeFor({ lifecycleState: 'dormant', formationAttemptCount: 3 });
        const remediation = narrative.facts.find((f) => f.label === 'group.activationRemediation');

        // An exhausted series in dormant is the application's move.
        expect(remediation?.value).toBe('awaiting-application');
        expect(remediation?.certainty).toBe('inferred');
    });

    it('degrades the policy-fed facts rather than lying when the policy is unreadable', () => {
        const facts = factsFor({ lifecycleState: 'active' }, null);

        for (const label of ['group.dataGate', 'group.activationRemediation', 'group.maxFormationAttempts']) {
            expect(facts[label]).toBe('unreadable');
        }
    });

    // Decision 37: the spent series denies a fresh `start` until a reset. No
    // claim is made about admission -- decision 38 keeps the policy's posture,
    // so a closed lobby stays closed.
    it('warns that a spent series will not dial until a reset', () => {
        const codes = warningCodesFor({ lifecycleState: 'dormant', formationAttemptCount: 3 });

        expect(codes).toContain('group-formation-series-parked');
    });

    it('does not call a never-started group parked', () => {
        const codes = warningCodesFor({ lifecycleState: 'dormant', formationAttemptCount: 0 });

        expect(codes).not.toContain('group-formation-series-parked');
    });

    // Keyed on the budget, not on a non-zero count: a group part-way through
    // its attempts is dormant with attempts spent but is not parked.
    it('does not call a group with budget left parked', () => {
        const codes = warningCodesFor({ lifecycleState: 'dormant', formationAttemptCount: 1 });

        expect(codes).not.toContain('group-formation-series-parked');
    });

    // The valve is orthogonal to the stage (product decision 25), so an active
    // group can be carrying no application data at all.
    it('warns that a halted group carries no application data', () => {
        expect(warningCodesFor({ transportState: 'halted' })).toContain('group-transport-halted');
        expect(warningCodesFor({ transportState: 'flowing' })).not.toContain('group-transport-halted');
    });
});

function narrativeFor(
    overrides: Partial<Parameters<typeof createTestGroup>[0]>,
    policy: GroupLifecyclePolicy | null = resolveGroupLifecyclePolicyPreset('managed')
) {
    const snapshot: GroupSnapshot = {
        causalRevision: { groupRevision: 7, presenceRevision: 3 },
        group: createTestGroup({ ...GROUP_REF, displayName: 'Room 1', ...overrides }),
        members: [],
        activeSessions: [],
        memberCount: 0,
        onlineMemberCount: 0
    };
    return projectGroupAdminSupportNarrative({
        request: { groupRef: GROUP_REF },
        snapshot,
        recentEvents: [],
        topologyView: undefined,
        hasGroupStateService: true,
        hasTopologyQuery: true,
        hasLifecyclePolicyReader: true,
        policy,
        generatedAtEpochMs: NOW
    });
}

function factsFor(
    overrides: Partial<Parameters<typeof createTestGroup>[0]>,
    policy?: GroupLifecyclePolicy | null
): Record<string, AdminSupportJsonValue> {
    return Object.fromEntries(narrativeFor(overrides, policy).facts.map((f) => [f.label, f.value]));
}

function warningCodesFor(
    overrides: Partial<Parameters<typeof createTestGroup>[0]>,
    policy?: GroupLifecyclePolicy | null
): readonly string[] {
    return narrativeFor(overrides, policy).warnings.map((w) => w.code);
}
