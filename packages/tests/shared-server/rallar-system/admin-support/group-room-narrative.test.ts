import { describe, expect, it } from 'vitest';

import { toGroupAdminSupportNarrative } from '@shared-server/rallar-system/admin-support/narratives/to-group-admin-support-narrative.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshot } from '../group-state/snapshot/group-state-snapshot-test-fixtures.ts';

const NOW = 1_000_000;

describe('operator room explanation', () => {
    it('separates away membership, current presence and spectator role without inferring gameplay', () => {
        const initial = createGroupSnapshot(2, ['player', 'watcher', 'expired']);
        const snapshot: GroupSnapshot = {
            ...initial,
            members: initial.members.map((member) =>
                member.principalId === 'principal-watcher'
                    ? { ...member, role: 'spectator' }
                    : member
            ),
            activeSessions: initial.activeSessions.map((session) =>
                session.sessionId === 'expired'
                    ? { ...session, expiresAtEpochMs: NOW }
                    : session
            )
        };
        const facts = explain(snapshot);

        expect(facts['group.members']?.value).toEqual([
            { principalId: 'alice', status: 'active', role: 'owner', presence: 'away', liveSessionCount: 0 },
            { principalId: 'principal-player', status: 'active', role: 'member', presence: 'present', liveSessionCount: 1 },
            { principalId: 'principal-watcher', status: 'active', role: 'spectator', presence: 'present', liveSessionCount: 1 },
            { principalId: 'principal-expired', status: 'active', role: 'member', presence: 'away', liveSessionCount: 0 }
        ]);
        expect(facts['group.activeSessionCount']?.value).toBe(2);
        expect(facts['group.onlineMemberCount']?.value).toBe(2);
        expect(facts['group.playerMemberCount']?.value).toBe(3);
        expect(facts['group.spectatorMemberCount']?.value).toBe(1);
        expect(facts['group.gameplayParticipation']).toMatchObject({ value: 'unknown', certainty: 'unavailable' });
    });

    it('does not describe an expired requested session as active', () => {
        const initial = createGroupSnapshot(2, ['expired']);
        const narrative = toGroupAdminSupportNarrative({
            request: { groupRef: initial.group, sessionId: 'expired' },
            snapshot: {
                ...initial,
                activeSessions: initial.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: NOW }))
            },
            recentEvents: [],
            topologyView: undefined,
            hasGroupStateService: true,
            hasTopologyQuery: true,
            policy: resolveGroupLifecyclePolicyPreset('managed'),
            generatedAtEpochMs: NOW
        });
        expect(narrative.facts.find((fact) => fact.label === 'group.session.match')).toMatchObject({
            value: 'missing',
            certainty: 'unavailable'
        });
        expect(narrative.warnings.some((warning) => warning.code === 'group-session-missing')).toBe(true);
    });

    it('reports temporary retention and schedule timing without exposing metadata or reservation identities', () => {
        const initial = createGroupSnapshot(2, []);
        const facts = explain({
            ...initial,
            group: {
                ...initial.group,
                joinMode: 'invite-only',
                metadata: {
                    rallarRetention: { mode: 'temporary', reconnectGraceMs: 600_000, emptyPresenceFingerprint: 'private-fingerprint' },
                    rallarDirectoryListing: 'unlisted',
                    rallarSessionSchedule: { revision: 2, startsAtEpochMs: NOW + 700_000, cancelledAtEpochMs: null },
                    secret: 'hidden-game-save'
                },
                emptySinceEpochMs: NOW - 1_000,
                purgeAfterEpochMs: NOW + 700_000
            }
        });

        expect(facts['group.retention']?.value).toEqual({
            mode: 'temporary',
            reconnectGraceMs: 600_000,
            emptySinceEpochMs: NOW - 1_000,
            purgeAfterEpochMs: NOW + 700_000,
            expiresAtEpochMs: null
        });
        expect(facts['group.schedule']?.value).toMatchObject({
            phase: 'upcoming',
            lobbyOpensAtEpochMs: NOW + 100_000,
            startsAtEpochMs: NOW + 700_000
        });
        expect(facts['group.admission']?.value).toMatchObject({ joinMode: 'invite-only', directoryListing: 'unlisted' });
        expect(facts['group.sessionReservations']).toMatchObject({ value: 'unknown', certainty: 'unavailable' });
        expect(JSON.stringify(facts)).not.toContain('private-fingerprint');
        expect(JSON.stringify(facts)).not.toContain('hidden-game-save');
    });

    it('explains the canonical closed lifecycle window and keeps unreadable policy unknown', () => {
        const initial = createGroupSnapshot(2, []);
        const match = resolveGroupLifecyclePolicyPreset('match');
        const closed = explain(initial, match);
        expect(closed['group.lifecycleAdmissionForUninvitedPlayer']?.value).toEqual({
            outcome: 'deny',
            reason: 'Group admission is closed outside formation.'
        });
        const forming = explain({ ...initial, group: { ...initial.group, lifecycleState: 'forming' } }, match);
        expect(forming['group.lifecycleAdmissionForUninvitedPlayer']?.value).toEqual({ outcome: 'admit', reason: null });
        const unreadable = explain(initial, null);
        expect(unreadable['group.lifecycleAdmissionForUninvitedPlayer']).toMatchObject({
            value: 'unknown',
            certainty: 'unavailable'
        });
    });

    it('reports absent optional policies as persistent and unscheduled but rejects malformed retained policy', () => {
        const initial = createGroupSnapshot(2, []);
        expect(explain(initial)['group.retention']?.value).toMatchObject({ mode: 'persistent', reconnectGraceMs: null });
        expect(explain(initial)['group.schedule']?.value).toBe(null);
        expect(() => explain({ ...initial, group: { ...initial.group, metadata: { rallarRetention: {} } } })).toThrow();
        expect(() => explain({ ...initial, group: { ...initial.group, metadata: { rallarSessionSchedule: {} } } })).toThrow();
    });
});

function explain(snapshot: GroupSnapshot, policy: GroupLifecyclePolicy | null = resolveGroupLifecyclePolicyPreset('managed')) {
    const narrative = toGroupAdminSupportNarrative({
        request: { groupRef: snapshot.group },
        snapshot,
        recentEvents: [],
        topologyView: undefined,
        hasGroupStateService: true,
        hasTopologyQuery: true,
        policy,
        generatedAtEpochMs: NOW
    });
    return Object.fromEntries(narrative.facts.map((fact) => [fact.label, fact]));
}
