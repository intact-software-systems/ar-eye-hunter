import { describe, expect, it } from 'vitest';
import {
    validateAuthoritativeClientSnapshot,
    validateAuthoritativeGroupSnapshot,
    validateAuthoritativeOverlayTopologySnapshot,
} from '@shared/api/authoritative-state-validation.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import {
    createClientSnapshotFixture,
    createGroupSnapshotFixture,
} from '../shared-web/authoritative-group-fixtures.ts';

const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };

describe('authoritative network state validation', () => {
    it('accepts canonical snapshots and rejects missing or wrong scope fields', () => {
        const client = createClientSnapshotFixture({
            ...scope,
            principalId: 'alice',
        });
        const group = createGroupSnapshotFixture({
            ...scope,
            groupId: 'room-1',
            sessionIds: ['alice-session'],
        });

        expect(() => validateAuthoritativeClientSnapshot(client, scope)).not.toThrow();
        expect(() => validateAuthoritativeGroupSnapshot(group, scope)).not.toThrow();
        expect(() => validateAuthoritativeClientSnapshot({
            ...client,
            principal: { ...client.principal, workspaceId: undefined },
        }, scope)).toThrow(/workspaceId/);
        expect(() => validateAuthoritativeGroupSnapshot({
            ...group,
            group: { ...group.group, workspaceId: 'workspace-2' },
        }, scope)).toThrow(/outside the requested scope/);
    });

    it('rejects missing causal authority, invalid discriminants, and bad array items', () => {
        const group = createGroupSnapshotFixture({
            ...scope,
            groupId: 'room-1',
            sessionIds: ['alice-session'],
        });
        const { causalRevision: omitted, ...missingCausalRevision } = group;
        expect(omitted).toBeDefined();
        expect(() => validateAuthoritativeGroupSnapshot(missingCausalRevision, scope))
            .toThrow(/causalRevision/);
        expect(() => validateAuthoritativeGroupSnapshot({
            ...group,
            group: { ...group.group, kind: 'invalid-kind' },
        }, scope)).toThrow(/kind/);
        expect(() => validateAuthoritativeGroupSnapshot({
            ...group,
            activeSessions: [{ ...group.activeSessions[0], sessionId: 42 }],
        }, scope)).toThrow(/sessionId/);
    });

    it('rejects lifecycle omissions and malformed topology collections', () => {
        const group = createGroupSnapshotFixture({
            ...scope,
            groupId: 'room-1',
            sessionIds: ['alice-session'],
        });
        expect(() => validateAuthoritativeGroupSnapshot({
            ...group,
            members: [{ ...group.members[0], joined: null }],
        }, scope)).toThrow(/joined/);

        const topology = {
            sourceGroupStateCausalRevision: group.causalRevision,
            state: 'active',
            overlayId: toScopedOverlayId(group.group),
            groupRef: { ...scope, groupId: group.group.groupId },
            name: group.group.displayName,
            topology: 'star',
            activeSessionIds: ['alice-session'],
            nextHopsBySessionId: { 'alice-session': [] },
            degreeLimit: 1,
            version: 1,
            createdByClientId: 'server',
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1,
        };
        expect(() => validateAuthoritativeOverlayTopologySnapshot(topology, scope))
            .not.toThrow();
        expect(() => validateAuthoritativeOverlayTopologySnapshot({
            ...topology,
            activeSessionIds: ['alice-session', 42],
        }, scope)).toThrow(/activeSessionIds/);
        expect(() => validateAuthoritativeOverlayTopologySnapshot({
            ...topology,
            groupRef: { ...topology.groupRef, unexpected: true },
        }, scope)).toThrow(/unexpected/);
    });
});
