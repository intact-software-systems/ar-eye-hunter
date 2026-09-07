// deno-lint-ignore-file no-explicit-any
import type { RallarBlackBoxTestEvent } from '../../rallar-bb-test/types.ts';
import type {
    RallarRemoteBrowserControlEventEnvelope,
    RallarRemoteBrowserControlRunSnapshot
} from '../rallar-remote-browser-provider.ts';
import { rememberRtcCloseEvent, rememberRtcDiagnostic, rememberRtcMessage } from '../rtc/rtc-wait-expectations.ts';

interface RemoteBrowserObservationState {
    readonly seenEventIds: Set<string>;
}

export function storeRemoteBrowserEvents(
    snapshot: RallarRemoteBrowserControlRunSnapshot | undefined,
    context: any
): void {
    const state = initRemoteBrowserObservationState(context);
    for (const event of snapshot?.events ?? []) {
        const id = event.eventId ?? `${event.kind}:${event.atEpochMs}:${event.commandId ?? ''}`;
        if (state.seenEventIds.has(id)) {
            continue;
        }
        state.seenEventIds.add(id);
        const payload = eventPayload(event);
        if (!payload) {
            continue;
        }
        const connectionName = payload.connection ?? 'default';
        if (payload.kind === 'diagnostic') {
            rememberRtcDiagnostic(connectionName, toRemoteRtcDiagnostic(payload, connectionName), context);
        }
        else if (payload.kind === 'message' && payload.transport === 'ws') {
            rememberRemoteWsMessage(connectionName, toRemoteWsMessage(payload), context);
        }
        else if (payload.kind === 'message') {
            rememberRtcMessage(connectionName, toRemoteRtcMessage(payload, connectionName), context);
        }
        else if (payload.kind === 'event' && payload.transport === 'ws' && payload.topic === 'rallar.bb.ws.closed') {
            rememberRemoteWsCloseEvent(connectionName, toRemoteWsClose(payload), context);
        }
        else if (isRemoteRtcCloseEvent(payload)) {
            rememberRtcCloseEvent(connectionName, toRemoteRtcClose(payload), context);
        }
    }
}

function initRemoteBrowserObservationState(context: any): RemoteBrowserObservationState {
    if (!context.rallarRemoteBrowser) {
        context.rallarRemoteBrowser = {
            seenEventIds: new Set<string>()
        };
    }
    return context.rallarRemoteBrowser;
}

function eventPayload(event: RallarRemoteBrowserControlEventEnvelope): RallarBlackBoxTestEvent | undefined {
    const payload = event.payload;
    return payload && typeof payload === 'object' && 'kind' in payload
        ? payload as RallarBlackBoxTestEvent
        : undefined;
}

function parseRemoteWsData(data: unknown): unknown {
    if (typeof data !== 'string') {
        return data;
    }

    try {
        return JSON.parse(data);
    }
    catch (_ignored) {
        return data;
    }
}

function rememberRemoteWsMessage(connectionName: string, message: any, context: any): void {
    if (!context.wsMessages) {
        context.wsMessages = {};
    }
    if (!context.wsMessages[connectionName]) {
        context.wsMessages[connectionName] = [];
    }

    context.wsMessages[connectionName].push(message);
}

function rememberRemoteWsCloseEvent(connectionName: string, closeEvent: any, context: any): void {
    if (!context.wsCloseEvents) {
        context.wsCloseEvents = {};
    }
    if (!context.wsCloseEvents[connectionName]) {
        context.wsCloseEvents[connectionName] = [];
    }

    context.wsCloseEvents[connectionName].push(closeEvent);
}

function toRemotePayloadRecord(payload: RallarBlackBoxTestEvent): Record<string, unknown> {
    return payload.payload && typeof payload.payload === 'object' && !Array.isArray(payload.payload)
        ? payload.payload as Record<string, unknown>
        : {};
}

function toRemoteRtcMessageData(payload: RallarBlackBoxTestEvent, connectionName: string): Record<string, unknown> {
    const payloadRecord = toRemotePayloadRecord(payload);
    const data = Object.prototype.hasOwnProperty.call(payloadRecord, 'data')
        ? payloadRecord.data
        : payload.payload;

    return {
        kind: 'message',
        topic: payload.topic,
        connection: connectionName,
        actor: payload.actor,
        transport: payload.transport,
        roomId: payloadRecord.roomId,
        roomRef: payloadRecord.roomRef,
        scope: payloadRecord.scope,
        applicationId: payloadRecord.applicationId,
        workspaceId: payloadRecord.workspaceId,
        laneId: payloadRecord.laneId,
        peerId: payloadRecord.peerId,
        remotePeerId: payloadRecord.remotePeerId,
        senderId: payloadRecord.senderId,
        typeId: payloadRecord.typeId,
        topicId: payloadRecord.topicId,
        contextId: payloadRecord.contextId,
        resourceId: payloadRecord.resourceId,
        data,
        event: payload
    };
}

function isRemoteRtcCloseEvent(payload: RallarBlackBoxTestEvent): boolean {
    return payload.kind === 'event' &&
        payload.transport !== 'ws' &&
        (
            payload.topic === 'rallar.bb.rtc.closed' ||
            payload.topic === 'rallar.browser.rtc.closed' ||
            payload.topic === 'rallar.browser.provider.closed'
        );
}

function toRemoteRtcDiagnostic(payload: RallarBlackBoxTestEvent, connectionName: string): any {
    const payloadRecord: Readonly<Record<string, unknown>> = payload.payload && typeof payload.payload === 'object'
        ? { ...payload.payload }
        : {};
    return {
        kind: 'diagnostic',
        topic: payload.topic,
        severity: payload.severity ?? 'info',
        atEpochMs: payload.atEpochMs,
        commandId: payload.commandId,
        connection: connectionName,
        provider: 'rallar-remote-browser',
        actor: payload.actor,
        transport: payload.transport,
        roomId: payloadRecord.roomId,
        roomRef: payloadRecord.roomRef,
        scope: payloadRecord.scope,
        applicationId: payloadRecord.applicationId,
        workspaceId: payloadRecord.workspaceId,
        data: payloadRecord.data ?? payload.payload,
        error: payloadRecord.error,
        event: payload
    };
}

function toRemoteWsMessage(payload: RallarBlackBoxTestEvent): any {
    const payloadRecord = toRemotePayloadRecord(payload);
    const messagePayload = Object.hasOwn(payloadRecord, 'data') ? payloadRecord.data : payload.payload;
    return {
        data: parseRemoteWsData(messagePayload),
        receivedAtEpochMs: payload.atEpochMs,
        provider: 'rallar-remote-browser',
        commandId: payload.commandId
    };
}

function toRemoteRtcMessage(payload: RallarBlackBoxTestEvent, connectionName: string): any {
    const messageData = toRemoteRtcMessageData(payload, connectionName);
    return {
        data: messageData,
        receivedAtEpochMs: payload.atEpochMs,
        provider: 'rallar-remote-browser',
        actor: payload.actor,
        roomId: messageData.roomId,
        roomRef: messageData.roomRef,
        scope: messageData.scope,
        applicationId: messageData.applicationId,
        workspaceId: messageData.workspaceId,
        commandId: payload.commandId
    };
}

function toRemoteWsClose(payload: RallarBlackBoxTestEvent): any {
    const closePayload = payload.payload && typeof payload.payload === 'object' ? { ...payload.payload } : {};
    return {
        ...closePayload,
        closedAtEpochMs: payload.atEpochMs,
        provider: 'rallar-remote-browser',
        commandId: payload.commandId
    };
}

function toRemoteRtcClose(payload: RallarBlackBoxTestEvent): any {
    const closePayload = toRemotePayloadRecord(payload);
    return {
        ...closePayload,
        closedAtEpochMs: payload.atEpochMs,
        provider: 'rallar-remote-browser',
        actor: payload.actor,
        transport: payload.transport,
        commandId: payload.commandId,
        event: payload
    };
}
