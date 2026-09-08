import type { RallarRtcClientArgs } from '../rallar-rtc-provider.ts';
import { toRallarScopeDiagnostics } from '../recipes/recipe-rallar-scope.ts';
import { toRtcExpectedConnectionName } from '../rtc/rtc-wait-expectations.ts';
import type { BlackBoxRallarConnectionConfig } from './rallar-browser-runtime/black-box-rallar-operation-contracts.ts';

export interface BrowserTransportSendInput {
    readonly message: any;
    readonly interaction: any;
    readonly args: RallarRtcClientArgs;
    readonly targetPeerIds: readonly string[];
}

export function toBrowserTransportSendInput(read: BrowserTransportSendInput): any {
    const { message, interaction, args, targetPeerIds } = read;
    const input = toBrowserSendInputBase(message, args);
    const roomId = input.roomId !== undefined ? input.roomId : args.roomId;
    const sendRequest = interaction?.request ?? args.request ?? {};
    const scopeFields = toRallarScopeDiagnostics(sendRequest, roomId ?? args.roomId);
    const minSnapshotVersion = [sendRequest.minSnapshotVersion, sendRequest.rallar?.minSnapshotVersion].find((value) =>
        value !== undefined
    );
    const transport = toArgsTransport(args);
    const inferredPeers = transport === 'messages.rtc'
        ? (!input.nextHopPeerIds && !input.peerIds ? { nextHopPeerIds: targetPeerIds } : {})
        : (!input.peerIds && !input.remotePeerId ? { peerIds: targetPeerIds } : {});
    return {
        ...input,
        ...(targetPeerIds.length > 0 ? inferredPeers : {}),
        ...(roomId !== undefined ? { roomId } : {}),
        ...Object.fromEntries(Object.entries(scopeFields).filter(([key]) => input[key] === undefined)),
        ...(input.minSnapshotVersion === undefined && minSnapshotVersion !== undefined ? { minSnapshotVersion } : {})
    };
}

export function toBrowserRuntimeConfig(
    args: RallarRtcClientArgs
): BlackBoxRallarConnectionConfig {
    const request = args.request || {};
    const rallar = asObject(request.rallar);
    const scopeDiagnostics = toRallarScopeDiagnostics(request, args.roomId);

    return {
        connection: args.connection,
        actor: args.actor,
        peerId: args.peerId,
        remotePeerId: args.remotePeerId,
        roomId: args.roomId,
        roomRef: scopeDiagnostics.roomRef,
        rallar: {
            ...rallar,
            apiBaseUrl: [rallar.apiBaseUrl, request.apiBaseUrl, request.rallarApiBaseUrl].find((value) =>
                value !== undefined
            ),
            username: [rallar.username, request.username].find((value) => value !== undefined),
            password: [rallar.password, request.password].find((value) => value !== undefined),
            displayName: [rallar.displayName, request.displayName].find((value) => value !== undefined),
            transport: [rallar.transport, request.transport].find((value) => value !== undefined),
            laneId: [rallar.laneId, request.laneId].find((value) => value !== undefined),
            typeId: [rallar.typeId, request.typeId, request.messageTypeId].find((value) => value !== undefined),
            topicId: [rallar.topicId, request.topicId].find((value) => value !== undefined),
            contextId: [rallar.contextId, request.contextId].find((value) => value !== undefined),
            resourceId: [rallar.resourceId, request.resourceId].find((value) => value !== undefined),
            messageSelector: [rallar.messageSelector, request.messageSelector].find((value) => value !== undefined),
            applicationId: scopeDiagnostics.applicationId,
            workspaceId: scopeDiagnostics.workspaceId,
            scope: scopeDiagnostics.scope,
            roomRef: scopeDiagnostics.roomRef,
            minSnapshotVersion: [rallar.minSnapshotVersion, request.minSnapshotVersion].find((value) =>
                value !== undefined
            ),
            openTimeoutMs: [rallar.openTimeoutMs, request.openTimeoutMs].find((value) => value !== undefined),
            timeoutMs: [rallar.timeoutMs, request.timeoutMs, request.connectTimeoutMs].find((value) =>
                value !== undefined
            ),
            peerIds: [
                rallar.peerIds,
                request.peerIds,
                request.remotePeerId ? [String(request.remotePeerId)] : undefined
            ].find((value) => value !== undefined),
            nextHopPeerIds: [rallar.nextHopPeerIds, request.nextHopPeerIds].find((value) => value !== undefined)
        }
    };
}

export function isLocalOnlyCrdtOpen(action: string, request: any): boolean {
    return action === 'open' &&
        String(
                [request?.transport, request?.rallar?.crdtTransport, 'local-only'].find((value) => value !== undefined)
            ) === 'local-only';
}

export function toExpectedTargetConnectionNames(
    interaction: any,
    args: RallarRtcClientArgs
): string[] {
    if (!interaction) {
        return [];
    }

    const explicitTargets = [
        ...toStringArray(interaction.request?.deliverTo),
        ...toStringArray(interaction.request?.to),
        ...toStringArray(interaction.request?.toConnection),
        ...toStringArray(interaction.response?.connection),
        ...toStringArray(interaction.response?.onConnection),
        ...toStringArray(interaction.request?.expectConnection)
    ];

    const targets = explicitTargets.length > 0
        ? explicitTargets
        : [toRtcExpectedConnectionName(interaction)];

    return [...new Set(targets)]
        .filter((connectionName) => connectionName && connectionName !== args.connection);
}

function toBrowserSendInputBase(message: any, args: RallarRtcClientArgs): any {
    if (toArgsTransport(args) === 'messages.rtc') {
        return isBrowserMessagesRtcSendEnvelope(message)
            ? { ...message }
            : { payload: message };
    }

    return isBrowserRealtimeSendEnvelope(message)
        ? { ...message }
        : { data: message };
}

function isBrowserRealtimeSendEnvelope(message: any): boolean {
    return isRecord(message) &&
        (
            Object.hasOwn(message, 'data') ||
            Object.hasOwn(message, 'laneId') ||
            Object.hasOwn(message, 'roomId') ||
            Object.hasOwn(message, 'roomRef') ||
            Object.hasOwn(message, 'applicationId') ||
            Object.hasOwn(message, 'workspaceId') ||
            Object.hasOwn(message, 'scope') ||
            Object.hasOwn(message, 'peerIds') ||
            Object.hasOwn(message, 'remotePeerId') ||
            Object.hasOwn(message, 'openTimeoutMs') ||
            Object.hasOwn(message, 'key') ||
            Object.hasOwn(message, 'maxAgeMs')
        );
}

function isBrowserMessagesRtcSendEnvelope(message: any): boolean {
    return isRecord(message) &&
        (
            Object.hasOwn(message, 'payload') ||
            Object.hasOwn(message, 'data') ||
            Object.hasOwn(message, 'typeId') ||
            Object.hasOwn(message, 'topicId') ||
            Object.hasOwn(message, 'contextId') ||
            Object.hasOwn(message, 'resourceId') ||
            Object.hasOwn(message, 'roomId') ||
            Object.hasOwn(message, 'roomRef') ||
            Object.hasOwn(message, 'applicationId') ||
            Object.hasOwn(message, 'workspaceId') ||
            Object.hasOwn(message, 'scope') ||
            Object.hasOwn(message, 'peerIds') ||
            Object.hasOwn(message, 'nextHopPeerIds') ||
            Object.hasOwn(message, 'ttlHops') ||
            Object.hasOwn(message, 'ttlMs') ||
            Object.hasOwn(message, 'reliability') ||
            Object.hasOwn(message, 'ack') ||
            Object.hasOwn(message, 'ownership') ||
            Object.hasOwn(message, 'membershipEpoch') ||
            Object.hasOwn(message, 'minSnapshotVersion') ||
            Object.hasOwn(message, 'seq') ||
            Object.hasOwn(message, 'orderingKey') ||
            Object.hasOwn(message, 'overlayId') ||
            Object.hasOwn(message, 'fanoutLimit')
        );
}

function toArgsTransport(args: RallarRtcClientArgs): string {
    return String(
        [args.request?.rallar?.transport, args.request?.transport, 'realtime'].find((value) => value !== undefined)
    );
}

function toStringArray(value: any): string[] {
    if (value === undefined || value === null) {
        return [];
    }

    return (Array.isArray(value) ? value : [value]).map(String);
}

function isRecord(value: any): boolean {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function asObject(value: any): any {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
