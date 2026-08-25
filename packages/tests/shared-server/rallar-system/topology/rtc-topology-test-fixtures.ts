import type { ComputedRtcTopologyOutbox } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { AuditStamp, GroupSnapshot } from '@shared/api/group-types.ts';
import { createTestGroup } from '../../../create-test-group.ts';

interface CreateRtcTopologyRttMeasurementInput {
    readonly sessionIdFrom: string;
    readonly sessionIdTo: string;
    readonly rttMs: number;
    readonly version: number;
}

export function createRtcTopologyMemberIds(count: number): readonly string[] {
    return Array.from({ length: count }, (_, index) => `peer-${index + 1}`);
}

export function createRtcTopologyRttMeasurement(
    input: CreateRtcTopologyRttMeasurementInput
): RttMeasurementInfo {
    return {
        sessionIdFrom: input.sessionIdFrom,
        sessionIdTo: input.sessionIdTo,
        rttMs: input.rttMs,
        createdAtEpochMs: input.version,
        version: input.version
    };
}

export function createCentralRtcTopologyRttMeasurements(
    memberSessionIds: readonly string[],
    centralSessionId: string
): readonly RttMeasurementInfo[] {
    const measurements: RttMeasurementInfo[] = [];
    let version = 1;

    for (let i = 0; i < memberSessionIds.length; i++) {
        for (let j = i + 1; j < memberSessionIds.length; j++) {
            const from = memberSessionIds[i];
            const to = memberSessionIds[j];
            measurements.push({
                sessionIdFrom: from,
                sessionIdTo: to,
                rttMs: from === centralSessionId || to === centralSessionId ? 1 : 100,
                createdAtEpochMs: version,
                version: version++
            });
        }
    }

    return measurements;
}

export function createRtcTopologyGroupSnapshot(
    groupId: string,
    memberSessionIds: readonly string[]
): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';
    const ownerPrincipalId = memberSessionIds[0];
    if (!ownerPrincipalId) {
        throw new Error('Expected at least one member session fixture');
    }

    return {
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        group: createTestGroup({
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            activeMemberCount: memberSessionIds.length,
            ownerPrincipalId,
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0,
            created: createAuditStamp(1),
            updated: createAuditStamp(1)
        }),
        members: memberSessionIds.map((sessionId, index) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: index === 0 ? 'owner' : 'member',
            status: 'active',
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null,
            joined: createAuditStamp(1),
            updated: createAuditStamp(1)
        })),
        activeSessions: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            generationId: `${sessionId}-generation`,
            generationVersion: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null
        })),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length
    };
}

export function createComputedRtcTopologyOutbox(): ComputedRtcTopologyOutbox {
    const groupSnapshot = createRtcTopologyGroupSnapshot('group-1', ['session-1']);
    return {
        commandId: 'command-1',
        aggregateRef: groupSnapshot.group,
        acceptedCausalRevision: groupSnapshot.causalRevision,
        groupSnapshot,
        effectKind: 'rtc-topology-recompute',
        payloadKind: 'group-revision',
        senderId: 'server-1',
        resourceId: 'command-1:rtc-topology-recompute:group-revision:group=1;presence=0',
        requestOptions: toCanonicalGroupTopologyConfigPatch({}),
        publish: true,
        createdAtEpochMs: 1_800_000_000_000,
        expireAtEpochMs: 1_800_000_060_000
    };
}

function createAuditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId: 'owner' },
        reason: null,
        traceId: null,
        requestId: null
    };
}
