import { describe, expect, it } from 'vitest';

import { projectGroupAdminSupportNarrative } from '@shared-server/rallar-system/admin-support/narratives/project-group-admin-support-narrative.ts';
import type { AdminSupportJsonValue } from '@shared/api/admin-support/admin-support-types.ts';
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
        expect(facts['group.transportState']).toBe('flowing');
        // The tuple, never a bare version (product decision 29), so two
        // identities can be told apart by a reader.
        expect(facts['group.acceptedLayoutIdentity']).toBe('active r9/2 v3');
    });

    it('reports an unconfirmed status as unavailable rather than inventing a band', () => {
        const narrative = narrativeFor({ activationStatus: null });
        const condition = narrative.facts.find((f) => f.label === 'group.activationCondition');

        expect(condition?.value).toBe('unconfirmed');
        expect(condition?.certainty).toBe('unavailable');
    });

    it('reports the confirmed status the writer stored', () => {
        const narrative = narrativeFor({
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
                confirmedAtEpochMs: NOW - 100
            }
        });
        const byLabel = Object.fromEntries(narrative.facts.map((f) => [f.label, f]));

        expect(byLabel['group.activationCondition']?.value).toBe('degraded');
        expect(byLabel['group.activationCondition']?.certainty).toBe('exact');
        expect(byLabel['group.activationCoverageRate']?.value).toBe(0.6);
        expect(byLabel['group.activationCoverageBasis']?.value).toBe('active r9/2 v3');
    });

    // Product decision 38: a parked series keeps its admission posture, so the
    // lobby looks open while nothing will dial. That is the state an operator
    // is least likely to guess.
    it('warns that a parked series looks open but will not dial', () => {
        const codes = warningCodesFor({ lifecycleState: 'dormant', formationAttemptCount: 2 });

        expect(codes).toContain('group-formation-series-parked');
    });

    it('does not call a never-started group parked', () => {
        const codes = warningCodesFor({ lifecycleState: 'dormant', formationAttemptCount: 0 });

        expect(codes).not.toContain('group-formation-series-parked');
    });

    // The valve is orthogonal to the stage (product decision 25), so an active
    // group can be carrying no application data at all.
    it('warns that a halted group carries no application data', () => {
        expect(warningCodesFor({ transportState: 'halted' })).toContain('group-transport-halted');
        expect(warningCodesFor({ transportState: 'flowing' })).not.toContain('group-transport-halted');
    });
});

function narrativeFor(overrides: Partial<Parameters<typeof createTestGroup>[0]>) {
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
        generatedAtEpochMs: NOW
    });
}

function factsFor(
    overrides: Partial<Parameters<typeof createTestGroup>[0]>
): Record<string, AdminSupportJsonValue> {
    return Object.fromEntries(narrativeFor(overrides).facts.map((f) => [f.label, f.value]));
}

function warningCodesFor(overrides: Partial<Parameters<typeof createTestGroup>[0]>): readonly string[] {
    return narrativeFor(overrides).warnings.map((w) => w.code);
}
