import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    BlackBoxRallarConfig,
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarRoomRef,
    BlackBoxRallarSendInput,
    ResolvedBlackBoxRallarScope
} from './black-box-rallar-operation-contracts.ts';

export interface BlackBoxRallarSessionIdentity {
    readonly clientId: string;
    readonly sessionId: string;
    readonly username: string;
}

export interface BlackBoxRallarAuthenticationIdentity {
    readonly apiBaseUrl: string;
    readonly username: string;
}

export interface BlackBoxRallarConnectionTarget {
    readonly apiBaseUrl: string;
    readonly username: string;
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly roomId?: string;
    readonly roomRef?: BlackBoxRallarRoomRef;
}

interface BlackBoxRallarConnectionPolicyInput {
    readonly roomId?: string;
    readonly roomRef?: BlackBoxRallarRoomRef;
    readonly rallar: BlackBoxRallarConfig;
}

const DEFAULT_WORKSPACE_ID = 'default';

function normalizedRoomRef(roomRef: BlackBoxRallarRoomRef | undefined): GroupRef | undefined {
    return roomRef
        ? {
            applicationId: roomRef.applicationId,
            workspaceId: roomRef.workspaceId ?? DEFAULT_WORKSPACE_ID,
            groupId: roomRef.groupId
        }
        : undefined;
}

export function blackBoxRallarRoomRefOf(
    config: BlackBoxRallarConnectionPolicyInput,
    input?: BlackBoxRallarSendInput
): GroupRef | undefined {
    const explicit = input?.roomRef ?? config.rallar.roomRef ?? config.roomRef;
    if (explicit?.applicationId && explicit.groupId) {
        return normalizedRoomRef(explicit);
    }

    const roomId = input?.roomId ?? config.roomId;
    if (!roomId) {
        return undefined;
    }

    const applicationId = input?.applicationId ??
        input?.scope?.applicationId ??
        config.rallar.applicationId ??
        config.rallar.scope?.applicationId;
    if (!applicationId) {
        return undefined;
    }

    const workspaceId = input?.workspaceId ??
        input?.scope?.workspaceId ??
        config.rallar.workspaceId ??
        config.rallar.scope?.workspaceId;

    return {
        applicationId: String(applicationId),
        workspaceId: String(workspaceId ?? DEFAULT_WORKSPACE_ID),
        groupId: String(roomId)
    };
}

function normalizedMessageSelector(
    selector: BlackBoxRallarConnectionConfig['rallar']['messageSelector']
): BlackBoxRallarConfig['messageSelector'] {
    return typeof selector === 'string'
        ? selector
        : selector
        ? {
            topicId: selector.topicId,
            typeId: selector.typeId
        }
        : undefined;
}

function normalizedDataChannelLanes(
    lanes: BlackBoxRallarConnectionConfig['rallar']['dataChannelLanes']
): BlackBoxRallarConfig['dataChannelLanes'] {
    return lanes?.map((lane) => ({
        id: lane.id,
        label: lane.label,
        binaryType: lane.binaryType,
        init: lane.init
            ? {
                id: lane.init.id,
                maxPacketLifeTime: lane.init.maxPacketLifeTime,
                maxRetransmits: lane.init.maxRetransmits,
                negotiated: lane.init.negotiated,
                ordered: lane.init.ordered,
                protocol: lane.init.protocol
            }
            : undefined,
        flowControl: lane.flowControl
            ? {
                highWatermarkBytes: lane.flowControl.highWatermarkBytes,
                lowWatermarkBytes: lane.flowControl.lowWatermarkBytes,
                overflow: lane.flowControl.overflow,
                maxQueueItems: lane.flowControl.maxQueueItems
            }
            : undefined
    }));
}

export interface BlackBoxRallarLifecyclePolicyState {
    readonly status: 'idle' | 'authenticating' | 'authenticated' | 'connecting' | 'connected' | 'closing' | 'faulted';
    readonly activeTarget?: BlackBoxRallarConnectionTarget;
}

export interface BlackBoxRallarLifecycleRequest {
    readonly kind: 'authenticate' | 'connect';
    readonly target: BlackBoxRallarConnectionTarget;
}

export type BlackBoxRallarLifecycleDecision =
    | Readonly<{ kind: 'allow'; }>
    | Readonly<{ kind: 'reuse'; }>
    | Readonly<{ kind: 'reject'; reason: string; }>;

export function normalizeBlackBoxRallarApiBaseUrl(value: string): string {
    return value.trim().replace(/\/+$/, '');
}

export function blackBoxRallarAuthenticationIdentityOf(
    config: Pick<BlackBoxRallarConfig, 'apiBaseUrl' | 'username'>,
    restoredSession?: Pick<BlackBoxRallarSessionIdentity, 'username'>
): BlackBoxRallarAuthenticationIdentity {
    return {
        apiBaseUrl: normalizeBlackBoxRallarApiBaseUrl(config.apiBaseUrl),
        username: config.username ?? restoredSession?.username ?? ''
    };
}

export function blackBoxRallarConnectionTargetOf(
    config: BlackBoxRallarConnectionPolicyInput,
    restoredSession?: Pick<BlackBoxRallarSessionIdentity, 'username'>
): BlackBoxRallarConnectionTarget {
    const identity = blackBoxRallarAuthenticationIdentityOf(config.rallar, restoredSession);
    const roomRef = blackBoxRallarRoomRefOf(config);
    const applicationId = config.rallar.scope?.applicationId ?? roomRef?.applicationId ?? config.rallar.applicationId;
    const workspaceId = applicationId
        ? config.rallar.scope?.workspaceId ?? roomRef?.workspaceId ?? config.rallar.workspaceId ?? DEFAULT_WORKSPACE_ID
        : undefined;
    return {
        ...identity,
        ...(applicationId ? { applicationId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(config.roomId ? { roomId: config.roomId } : {}),
        ...(roomRef ? { roomRef } : {})
    };
}

export function blackBoxRallarConnectionOperationKeyOf(
    config: BlackBoxRallarConnectionConfig
): string {
    const rallar = config.rallar;
    return JSON.stringify({
        connection: config.connection,
        actor: config.actor,
        peerId: config.peerId,
        remotePeerId: config.remotePeerId,
        roomId: config.roomId,
        roomRef: normalizedRoomRef(config.roomRef),
        rallar: {
            apiBaseUrl: normalizeBlackBoxRallarApiBaseUrl(rallar.apiBaseUrl),
            applicationId: rallar.applicationId,
            workspaceId: rallar.workspaceId,
            scope: rallar.scope
                ? {
                    applicationId: rallar.scope.applicationId,
                    workspaceId: rallar.scope.workspaceId
                }
                : undefined,
            roomRef: normalizedRoomRef(rallar.roomRef),
            username: rallar.username,
            password: rallar.password,
            displayName: rallar.displayName,
            register: rallar.register,
            transport: rallar.transport,
            laneId: rallar.laneId,
            openTimeoutMs: rallar.openTimeoutMs,
            timeoutMs: rallar.timeoutMs,
            peerIds: rallar.peerIds,
            nextHopPeerIds: rallar.nextHopPeerIds,
            typeId: rallar.typeId,
            topicId: rallar.topicId,
            contextId: rallar.contextId,
            resourceId: rallar.resourceId,
            messageSelector: normalizedMessageSelector(rallar.messageSelector),
            ttlHops: rallar.ttlHops,
            ttlMs: rallar.ttlMs,
            reliability: rallar.reliability,
            ack: rallar.ack,
            ownership: rallar.ownership,
            membershipEpoch: rallar.membershipEpoch,
            minSnapshotVersion: rallar.minSnapshotVersion,
            seq: rallar.seq,
            orderingKey: rallar.orderingKey,
            overlayId: rallar.overlayId,
            fanoutLimit: rallar.fanoutLimit,
            dataChannelLanes: normalizedDataChannelLanes(rallar.dataChannelLanes),
            expectedSessionId: rallar.expectedSessionId,
            leaveRoomOnClose: rallar.leaveRoomOnClose,
            logoutOnClose: rallar.logoutOnClose
        }
    });
}

export function mergeBlackBoxRallarAuthenticationConfig(
    active: BlackBoxRallarConnectionConfig,
    next: BlackBoxRallarConnectionConfig
): BlackBoxRallarConnectionConfig {
    return {
        ...next,
        rallar: {
            ...next.rallar,
            logoutOnClose: active.rallar.logoutOnClose === true || next.rallar.logoutOnClose === true
        }
    };
}

export function isSameBlackBoxRallarSession(
    left: BlackBoxRallarSessionIdentity,
    right: BlackBoxRallarSessionIdentity
): boolean {
    return left.clientId === right.clientId && left.sessionId === right.sessionId && left.username === right.username;
}

function isSameConnectionTarget(
    left: BlackBoxRallarConnectionTarget | undefined,
    right: BlackBoxRallarConnectionTarget
): boolean {
    if (!left) {
        return false;
    }
    return JSON.stringify(left) === JSON.stringify(right);
}

export function decideBlackBoxRallarLifecycleRequest(
    state: BlackBoxRallarLifecyclePolicyState,
    request: BlackBoxRallarLifecycleRequest
): BlackBoxRallarLifecycleDecision {
    if (state.status === 'closing' || state.status === 'faulted') {
        return {
            kind: 'reject',
            reason: 'Rallar lifecycle cleanup must complete before starting a new operation.'
        };
    }
    if (
        (state.status === 'authenticating' || state.status === 'connecting') &&
        isSameConnectionTarget(state.activeTarget, request.target)
    ) {
        return { kind: 'reuse' };
    }
    if (state.status === 'connected' && !isSameConnectionTarget(state.activeTarget, request.target)) {
        return {
            kind: 'reject',
            reason: 'Connected Rallar identity, scope, or room changes require close first.'
        };
    }
    return { kind: 'allow' };
}

export interface BlackBoxRallarScopeDiagnostics {
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly scope?: ResolvedBlackBoxRallarScope;
    readonly roomRef?: GroupRef;
}

export function blackBoxRallarScopeOf(
    config: BlackBoxRallarConnectionPolicyInput,
    input?: BlackBoxRallarSendInput
): ResolvedBlackBoxRallarScope | undefined {
    const scope = input?.scope ?? config.rallar.scope;
    const roomRef = blackBoxRallarRoomRefOf(config, input);
    const applicationId = String(
        input?.applicationId ??
            scope?.applicationId ??
            roomRef?.applicationId ??
            config.rallar.applicationId ??
            ''
    ).trim();
    if (!applicationId) {
        return undefined;
    }

    const workspaceId = input?.workspaceId ??
        scope?.workspaceId ??
        roomRef?.workspaceId ??
        config.rallar.workspaceId ??
        DEFAULT_WORKSPACE_ID;

    return {
        applicationId,
        workspaceId: String(workspaceId)
    };
}

export function blackBoxRallarScopeDiagnosticsOf(
    config: BlackBoxRallarConnectionPolicyInput,
    input?: BlackBoxRallarSendInput
): BlackBoxRallarScopeDiagnostics {
    const scope = blackBoxRallarScopeOf(config, input);
    const roomRef = blackBoxRallarRoomRefOf(config, input);

    return {
        ...(scope?.applicationId ? { applicationId: scope.applicationId } : {}),
        ...(scope?.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
        ...(scope ? { scope } : {}),
        ...(roomRef ? { roomRef } : {})
    };
}
