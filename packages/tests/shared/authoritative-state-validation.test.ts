import { describe, expect, it } from 'vitest';
import {
    validateAuthoritativeClientSnapshot,
    validateAuthoritativeGroupSnapshot,
    validateAuthoritativeOverlayTopologySnapshot,
} from '@shared/api/authoritative-state-validation.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import {
    createActiveClientSessionFixture,
    createActiveGroupPresenceSessionFixture,
    createAuditStampFixture,
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

    it('rejects malformed principal versions, nullable profile fields, and actors', () => {
        const client = createClientSnapshotFixture({
            ...scope,
            principalId: 'alice',
        });
        const invalidPrincipals = [
            { ...client.principal, displayName: 42 },
            { ...client.principal, snapshotVersion: 0 },
            { ...client.principal, profileVersion: 1.5 },
            { ...client.principal, presenceVersion: '1' },
            { ...client.principal, lastSeenAtEpochMs: -1 },
            {
                ...client.principal,
                created: {
                    ...client.principal.created,
                    actor: { kind: 'principal', principalId: '' },
                },
            },
        ];

        for (const principal of invalidPrincipals) {
            expect(() => validateAuthoritativeClientSnapshot({
                ...client,
                principal,
            }, scope)).toThrow();
        }
    });

    it('rejects malformed instance nullable fields and active session authority', () => {
        const client = createClientSnapshotFixture({
            ...scope,
            principalId: 'alice',
        });
        const session = createActiveClientSessionFixture({
            ...scope,
            principalId: 'alice',
            clientInstanceId: 'alice-instance',
            sessionId: 'alice-session',
        });
        const invalidSessions = [
            { ...session, generationVersion: 0 },
            { ...session, connectionId: '' },
            { ...session, authenticatedAtEpochMs: 2 },
            { ...session, lastHeartbeatAtEpochMs: 60_001 },
            { ...session, expiresAtEpochMs: -1 },
        ];

        for (const invalidSession of invalidSessions) {
            expect(() => validateAuthoritativeClientSnapshot({
                ...client,
                activeSessions: [invalidSession],
                isOnline: true,
                activeSessionCount: 1,
            }, scope)).toThrow();
        }

        const audit = createAuditStampFixture(1, 'alice');
        expect(() => validateAuthoritativeClientSnapshot({
            ...client,
            instances: [{
                ...scope,
                principalId: 'alice',
                clientInstanceId: 'alice-instance',
                status: 'active',
                platform: 'web',
                deviceLabel: 42,
                appVersion: null,
                userAgent: null,
                capabilities: [],
                registered: audit,
                updated: audit,
                revoked: null,
            }],
        }, scope)).toThrow(/deviceLabel/);
    });

    it('rejects malformed group versions, nullable limits, timestamps, and sessions', () => {
        const group = createGroupSnapshotFixture({
            ...scope,
            groupId: 'room-1',
            sessionIds: ['alice'],
        });
        const invalidGroups = [
            { ...group.group, snapshotVersion: 0 },
            { ...group.group, metadataVersion: '1' },
            { ...group.group, rosterVersion: 1.5 },
            { ...group.group, maxMembers: 0 },
            { ...group.group, maxSessionsPerMember: -1 },
            { ...group.group, expiresAtEpochMs: 0 },
            { ...group.group, emptySinceEpochMs: '1' },
            { ...group.group, purgeAfterEpochMs: -1 },
        ];

        for (const invalidGroup of invalidGroups) {
            expect(() => validateAuthoritativeGroupSnapshot({
                ...group,
                group: invalidGroup,
            }, scope)).toThrow();
        }

        const session = createActiveGroupPresenceSessionFixture({
            ...scope,
            groupId: 'room-1',
            principalId: 'alice',
            sessionId: 'alice',
        });
        for (const invalidSession of [
            { ...session, generationVersion: 0 },
            { ...session, generationVersion: 1.5 },
            { ...session, lastHeartbeatAtEpochMs: 0 },
            { ...session, expiresAtEpochMs: 0 },
        ]) {
            expect(() => validateAuthoritativeGroupSnapshot({
                ...group,
                activeSessions: [invalidSession],
            }, scope)).toThrow();
        }
    });

    it('rejects invited or active member terminal stamps and malformed invitation fields', () => {
        const group = createGroupSnapshotFixture({
            ...scope,
            groupId: 'room-1',
            sessionIds: ['alice'],
        });
        const member = group.members[0];
        const audit = createAuditStampFixture(2, 'alice');
        const invalidMembers = [
            { ...member, left: audit },
            { ...member, invitedByPrincipalId: '' },
            { ...member, invitationExpiresAtEpochMs: 0 },
            {
                ...member,
                status: 'invited',
                joined: null,
                left: audit,
            },
        ];

        for (const invalidMember of invalidMembers) {
            expect(() => validateAuthoritativeGroupSnapshot({
                ...group,
                members: [invalidMember],
            }, scope)).toThrow();
        }
    });
});
