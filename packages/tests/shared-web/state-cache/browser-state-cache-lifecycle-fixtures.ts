import type { BrowserStateCacheLifecycle } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALBroadcastMessage,
    newALEventRoute,
    newALUnicastMessage
} from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { AuditStamp, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type {
    GroupEvent,
    GroupSnapshot,
    GroupStateCausalRevision
} from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { computeStateSnapshotPages, isStateSnapshotTopic } from '@shared/api/state-snapshot-page.ts';
import { vi } from 'vitest';
import { createTestGroup } from '../../create-test-group.ts';

export function createWebRtcGroupManager() {
    return {
        notifyClientPresenceChanged: vi.fn<BrowserStateCacheLifecycle.RtcGroupPort['notifyClientPresenceChanged']>(async () => undefined),
        notifyOverlayTopologyChanged: vi.fn<BrowserStateCacheLifecycle.RtcGroupPort['notifyOverlayTopologyChanged']>(async () => undefined),
        acceptGroupUpdate: vi.fn<BrowserStateCacheLifecycle.RtcGroupPort['acceptGroupUpdate']>(async () => undefined),
        ensureAllGroupsConnected: vi.fn<BrowserStateCacheLifecycle.RtcGroupPort['ensureAllGroupsConnected']>(async () => undefined),
        delete: vi.fn<BrowserStateCacheLifecycle.RtcGroupPort['delete']>(async () => true),
        has: vi.fn<BrowserStateCacheLifecycle.RtcGroupPort['has']>(() => false)
    } satisfies BrowserStateCacheLifecycle.RtcGroupPort;
}

export interface CreateClientSnapshotInput {
    readonly principalId: string;
    readonly sessionId: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly snapshotVersion: number;
}

export function createClientSnapshot(
    input: CreateClientSnapshotInput
): ClientSnapshot {
    const {
        principalId,
        sessionId,
        applicationId,
        workspaceId,
        snapshotVersion
    } = input;
    return {
        stateRevision: snapshotVersion,
        principal: {
            applicationId,
            workspaceId,
            principalId,
            username: principalId,
            displayName: null,
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            status: 'active',
            roles: [],
            metadata: {},
            snapshotVersion,
            profileVersion: snapshotVersion,
            presenceVersion: 1,
            created: auditStamp(1),
            updated: auditStamp(snapshotVersion),
            disabled: null,
            deleted: null,
            lastSeenAtEpochMs: snapshotVersion
        },
        instances: [],
        activeSessions: [{
            applicationId,
            workspaceId,
            principalId,
            clientInstanceId: `${principalId}-instance`,
            sessionId,
            status: 'active',
            generationId: `generation-${snapshotVersion}`,
            generationVersion: snapshotVersion,
            presenceState: 'online',
            transport: 'ws',
            authenticatedAtEpochMs: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: snapshotVersion,
            expiresAtEpochMs: 60_000,
            connectionId: null,
            disconnectedAtEpochMs: null,
            disconnectReason: null
        }],
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: snapshotVersion
    };
}

export interface CreateGroupSnapshotInput {
    readonly groupId: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly sessionIds: readonly string[];
    readonly snapshotVersion: number;
}

export function createGroupSnapshot(
    input: CreateGroupSnapshotInput
): GroupSnapshot {
    const {
        groupId,
        applicationId,
        workspaceId,
        sessionIds,
        snapshotVersion
    } = input;
    const ownerPrincipalId = sessionIds[0];
    if (!ownerPrincipalId) {
        throw new TypeError('Group fixture requires an owner');
    }
    return {
        causalRevision: {
            groupRevision: snapshotVersion,
            presenceRevision: snapshotVersion
        },
        group: createTestGroup({
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            snapshotVersion,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: snapshotVersion,
            created: auditStamp(1),
            updated: auditStamp(snapshotVersion),
            activeMemberCount: sessionIds.length,
            ownerPrincipalId
        }),
        members: sessionIds.map((sessionId, index) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: index === 0 ? 'owner' : 'member',
            status: 'active',
            joined: auditStamp(1),
            updated: auditStamp(snapshotVersion),
            left: null,
            removed: null,
            banned: null,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null
        })),
        activeSessions: toGroupFixtureActiveSessions(input),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length
    };
}

function toGroupFixtureActiveSessions(input: CreateGroupSnapshotInput): GroupSnapshot['activeSessions'] {
    return input.sessionIds.map((sessionId) => ({
        applicationId: input.applicationId,
        workspaceId: input.workspaceId,
        groupId: input.groupId,
        sessionId,
        principalId: sessionId,
        generationId: `generation-${input.snapshotVersion}`,
        generationVersion: input.snapshotVersion,
        status: 'active',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: input.snapshotVersion,
        expiresAtEpochMs: 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    }));
}

export function createTopologySnapshot(
    group: GroupSnapshot,
    causalRevision: GroupSnapshot['causalRevision'],
    version: number
): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateCausalRevision: causalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(group.group),
        groupRef: {
            applicationId: group.group.applicationId,
            workspaceId: group.group.workspaceId,
            groupId: group.group.groupId
        },
        name: group.group.displayName,
        topology: 'tree',
        activeSessionIds: ['session-a', 'session-b'],
        nextHopsBySessionId: {
            'session-a': ['session-b'],
            'session-b': ['session-a']
        },
        degreeLimit: 5,
        version,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        updatedAtEpochMs: version
    };
}

export function withTopologyMessageId<T extends { readonly id: Readonly<{ readonly msgId: string; }>; }>(
    message: T,
    messageId: string
): T {
    return {
        ...message,
        id: { ...message.id, msgId: messageId }
    };
}

export interface CreateCurrentStateTopologyMessageInput {
    readonly deliveryKind:
        | 'rtc-topology-current-repair'
        | 'rtc-topology-hydration';
    readonly senderId: string;
    readonly group: GroupSnapshot;
    readonly topology: RallarOverlayTopologySnapshot;
    readonly resourceId: string;
}

export function newCurrentStateTopologyMessage(
    input: CreateCurrentStateTopologyMessageInput
) {
    const { deliveryKind, senderId, group, topology, resourceId } = input;
    const route = newALEventRoute(
        AppTopics.overlayTopology,
        group.group.groupId,
        resourceId
    );
    if (deliveryKind === 'rtc-topology-current-repair') {
        return newALBroadcastMessage(senderId, route, 'room', AppTopics.overlayTopology, topology, { groupRef: group.group });
    }
    const message = newALUnicastMessage(senderId, route, 'session-a', AppTopics.overlayTopology, topology);
    return { ...message, id: { ...message.id, sessionId: 'session-a' } };
}

export function toCurrentTopologyMessageId(
    deliveryKind: 'rtc-topology-current-repair' | 'rtc-topology-hydration',
    topology: RallarOverlayTopologySnapshot
): string {
    const revision = topology.sourceGroupStateCausalRevision;
    return deliveryKind === 'rtc-topology-current-repair'
        ? JSON.stringify([
            deliveryKind,
            JSON.stringify([
                topology.groupRef.applicationId,
                topology.groupRef.workspaceId === undefined
                    ? ['absent']
                    : ['present', topology.groupRef.workspaceId],
                topology.groupRef.groupId
            ]),
            revision.groupRevision,
            revision.presenceRevision,
            topology.version
        ])
        : JSON.stringify([
            deliveryKind,
            topology.groupRef.applicationId,
            topology.groupRef.workspaceId,
            topology.groupRef.groupId,
            'session-a',
            'generation-a',
            revision.groupRevision,
            revision.presenceRevision,
            topology.version
        ]);
}

export function withGroupCausalRevision(
    snapshot: GroupSnapshot,
    causalRevision: GroupSnapshot['causalRevision']
): GroupSnapshot {
    return {
        ...snapshot,
        causalRevision,
        group: {
            ...snapshot.group,
            snapshotVersion: causalRevision.groupRevision,
            presenceVersion: causalRevision.presenceRevision
        }
    };
}

export function createGroupStateDeltaEnvelope(
    resulting: GroupSnapshot,
    predecessorCausalRevision: GroupStateCausalRevision
): GroupStateDeltaEnvelope {
    const activeSessionIds = resulting.activeSessions.map(
        (session) => session.sessionId
    );
    return {
        event: {
            applicationId: resulting.group.applicationId,
            workspaceId: resulting.group.workspaceId,
            groupId: resulting.group.groupId,
            eventId: `event-${resulting.group.groupId}-g${resulting.causalRevision.groupRevision}-p${resulting.causalRevision.presenceRevision}`,
            eventType: 'session-heartbeat',
            snapshotVersion: resulting.group.snapshotVersion,
            causalRevision: resulting.causalRevision,
            occurredAtEpochMs: 1,
            actor: { kind: 'service', serviceId: 'summary-worker' },
            reason: null,
            traceId: null,
            requestId: 'request-delta',
            payload: {}
        },
        predecessorCausalRevision,
        resultingCausalRevision: resulting.causalRevision,
        members: [],
        removedMemberPrincipalIds: [],
        sessions: [],
        removedSessionIds: [],
        activeSessionIds,
        group: resulting.group,
        memberCount: resulting.memberCount,
        onlineMemberCount: resulting.onlineMemberCount,
        audienceSessionIds: activeSessionIds
    };
}

export function groupSnapshotResponse(snapshot: GroupSnapshot): Response {
    return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'rallar-state-source': 'durable',
            'rallar-group-revision': String(snapshot.causalRevision.groupRevision),
            'rallar-presence-revision': String(
                snapshot.causalRevision.presenceRevision
            )
        }
    });
}

export function createGroupEvent(
    groupId: string,
    eventId: string
): GroupEvent {
    return {
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        groupId,
        eventId,
        eventType: 'member-joined',
        snapshotVersion: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        occurredAtEpochMs: 1,
        actor: {
            kind: 'session',
            principalId: 'alice',
            sessionId: 'session-a'
        },
        reason: null,
        traceId: null,
        requestId: 'request-1',
        payload: {}
    };
}

export function auditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}

/** Produces the current page protocol at the fake server's outbound port. */
export function createPagedSnapshotReceiver(receive: (message: ALMessage) => Promise<void>) {
    return async (message: ALMessage): Promise<void> => {
        if (!isStateSnapshotTopic(message.payload.typeId)) {
            return receive(message);
        }
        const payload = readFixtureRecord(JSON.parse(message.payload.resource));
        const topology = message.payload.typeId === AppTopics.overlayTopology;
        const principal = message.payload.typeId === AppTopics.clientStateSnapshot;
        const identity = readFixtureRecord(payload[topology ? 'groupRef' : principal ? 'principal' : 'group']);
        const scope = {
            kind: principal ? 'principal' as const : 'group' as const,
            applicationId: String(identity.applicationId),
            workspaceId: String(identity.workspaceId),
            resourceId: String(identity[principal ? 'principalId' : 'groupId'])
        };
        const causal = principal ? undefined : readFixtureRecord(payload[topology ? 'sourceGroupStateCausalRevision' : 'causalRevision']);
        const revision = topology
            ? JSON.stringify([causal!.groupRevision, causal!.presenceRevision, payload.version])
            : principal
            ? `revision=${payload.stateRevision}`
            : `group=${causal!.groupRevision};presence=${causal!.presenceRevision}`;
        const targets = message.targets?.mode === 'unicast'
            ? message.targets
            : principal
            ? {
                mode: 'broadcast' as const,
                scope: 'principal' as const,
                principalRef: { applicationId: scope.applicationId, workspaceId: scope.workspaceId, principalId: scope.resourceId }
            }
            : {
                mode: 'broadcast' as const,
                scope: 'room' as const,
                groupRef: { applicationId: scope.applicationId, workspaceId: scope.workspaceId, groupId: scope.resourceId }
            };
        const pages = computeStateSnapshotPages({
            scope,
            revision,
            resource: message.payload.resource,
            envelope: {
                id: message.id,
                route: message.route,
                targets,
                delivery: { reliability: 'best-effort', ack: 'none' },
                constraints: { expiresAtMs: message.id.ts + 60_000 },
                audit: { createdBy: message.id.senderId, createdTs: message.id.ts }
            }
        }).fold((issue) => {
            throw new TypeError(issue.message);
        }, (messages) => messages);
        for (const page of pages) {
            await receive(page);
        }
    };
}

function readFixtureRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Snapshot fixture requires a record');
    }
    return value as Record<string, unknown>;
}
