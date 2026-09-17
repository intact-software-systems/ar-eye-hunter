// deno-lint-ignore-file no-explicit-any
import type {
    ApiJsonObject,
    ApiJsonValue
} from '../../../shared/api/api-json-value.ts';

import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestTransport
} from '../../rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    rememberRtcCloseEvent,
    rememberRtcDiagnostic,
    rememberRtcMessage
} from '../rtc/rtc-wait-expectations.ts';
import type {
    RemoteBrowserObservationEvent,
    RemoteBrowserObservations
} from './decode-remote-browser-observations.ts';

interface RemoteBrowserObservationState {
    readonly seenEventIds: Set<string>;
}

/** An RTC message as the runner stores it; payload members the browser did not send are undefined. */
interface RemoteRtcMessageContent {
    readonly kind: 'message';
    readonly topic: string;
    readonly connection: string;
    readonly actor: string | undefined;
    readonly transport: RallarBlackBoxTestTransport | undefined;
    readonly roomId: ApiJsonValue | undefined;
    readonly roomRef: ApiJsonValue | undefined;
    readonly scope: ApiJsonValue | undefined;
    readonly applicationId: ApiJsonValue | undefined;
    readonly workspaceId: ApiJsonValue | undefined;
    readonly laneId: ApiJsonValue | undefined;
    readonly peerId: ApiJsonValue | undefined;
    readonly remotePeerId: ApiJsonValue | undefined;
    readonly senderId: ApiJsonValue | undefined;
    readonly typeId: ApiJsonValue | undefined;
    readonly topicId: ApiJsonValue | undefined;
    readonly contextId: ApiJsonValue | undefined;
    readonly resourceId: ApiJsonValue | undefined;
    readonly data: ApiJsonValue | undefined;
    readonly event: RallarBlackBoxTestEvent<ApiJsonValue>;
}

const RTC_CLOSE_TOPICS = ['rallar.bb.rtc.closed', 'rallar.browser.rtc.closed', 'rallar.browser.provider.closed'];

/** Appends each event this context has not seen to the runner's RTC and WebSocket stores for its connection. */
export function appendRemoteBrowserEvents(observations: RemoteBrowserObservations, context: any): void {
    const state = initRemoteBrowserObservationState(context);
    for (const event of observations.events) {
        const eventId = toObservedEventId(event);
        if (!state.seenEventIds.has(eventId)) {
            state.seenEventIds.add(eventId);
            appendRemoteBrowserEvent(event.payload, context);
        }
    }
}

function appendRemoteBrowserEvent(event: RallarBlackBoxTestEvent<ApiJsonValue>, context: any): void {
    const connectionName = event.connection ?? 'default';
    if (event.kind === 'diagnostic') {
        rememberRtcDiagnostic(connectionName, toRemoteRtcDiagnostic(event, connectionName), context);
    }
    else if (event.kind === 'message' && event.transport === 'ws') {
        ((context.wsMessages ??= {})[connectionName] ??= []).push(toRemoteWsMessage(event));
    }
    else if (event.kind === 'message') {
        rememberRtcMessage(connectionName, toRemoteRtcMessage(event, connectionName), context);
    }
    else if (event.kind === 'event' && event.transport === 'ws' && event.topic === 'rallar.bb.ws.closed') {
        ((context.wsCloseEvents ??= {})[connectionName] ??= []).push(toRemoteWsClose(event));
    }
    else if (event.kind === 'event' && event.transport !== 'ws' && RTC_CLOSE_TOPICS.includes(event.topic)) {
        rememberRtcCloseEvent(connectionName, toRemoteRtcClose(event), context);
    }
}

function initRemoteBrowserObservationState(context: any): RemoteBrowserObservationState {
    context.rallarRemoteBrowser ??= { seenEventIds: new Set<string>() };
    return context.rallarRemoteBrowser;
}

function toObservedEventId(event: RemoteBrowserObservationEvent): string {
    return event.eventId ?? `${event.kind}:${event.atEpochMs}:${event.commandId ?? ''}`;
}

function toPayloadRecord(event: RallarBlackBoxTestEvent<ApiJsonValue>): ApiJsonObject {
    return isApiJsonObject(event.payload) ? event.payload : {};
}

function toMessageBody(event: RallarBlackBoxTestEvent<ApiJsonValue>): ApiJsonValue | undefined {
    const payload = toPayloadRecord(event);
    return Object.hasOwn(payload, 'data') ? payload.data : event.payload;
}

function toRemoteRtcMessageContent(
    event: RallarBlackBoxTestEvent<ApiJsonValue>,
    connectionName: string
): RemoteRtcMessageContent {
    const payload = toPayloadRecord(event);
    return {
        kind: 'message',
        topic: event.topic,
        connection: connectionName,
        actor: event.actor,
        transport: event.transport,
        roomId: payload.roomId,
        roomRef: payload.roomRef,
        scope: payload.scope,
        applicationId: payload.applicationId,
        workspaceId: payload.workspaceId,
        laneId: payload.laneId,
        peerId: payload.peerId,
        remotePeerId: payload.remotePeerId,
        senderId: payload.senderId,
        typeId: payload.typeId,
        topicId: payload.topicId,
        contextId: payload.contextId,
        resourceId: payload.resourceId,
        data: toMessageBody(event),
        event
    };
}

function toRemoteRtcDiagnostic(event: RallarBlackBoxTestEvent<ApiJsonValue>, connectionName: string): any {
    const payload = toPayloadRecord(event);
    return {
        kind: 'diagnostic',
        topic: event.topic,
        severity: event.severity ?? 'info',
        atEpochMs: event.atEpochMs,
        commandId: event.commandId,
        connection: connectionName,
        provider: 'rallar-remote-browser',
        actor: event.actor,
        transport: event.transport,
        roomId: payload.roomId,
        roomRef: payload.roomRef,
        scope: payload.scope,
        applicationId: payload.applicationId,
        workspaceId: payload.workspaceId,
        data: payload.data ?? event.payload,
        error: payload.error,
        event
    };
}

function toRemoteWsMessage(event: RallarBlackBoxTestEvent<ApiJsonValue>): any {
    return {
        data: toRemoteWsMessageValue(toMessageBody(event)),
        receivedAtEpochMs: event.atEpochMs,
        provider: 'rallar-remote-browser',
        commandId: event.commandId
    };
}

function toRemoteRtcMessage(event: RallarBlackBoxTestEvent<ApiJsonValue>, connectionName: string): any {
    const content = toRemoteRtcMessageContent(event, connectionName);
    return {
        data: content,
        receivedAtEpochMs: event.atEpochMs,
        provider: 'rallar-remote-browser',
        actor: event.actor,
        roomId: content.roomId,
        roomRef: content.roomRef,
        scope: content.scope,
        applicationId: content.applicationId,
        workspaceId: content.workspaceId,
        commandId: event.commandId
    };
}

function toRemoteWsClose(event: RallarBlackBoxTestEvent<ApiJsonValue>): any {
    return {
        ...toPayloadRecord(event),
        closedAtEpochMs: event.atEpochMs,
        provider: 'rallar-remote-browser',
        commandId: event.commandId
    };
}

function toRemoteRtcClose(event: RallarBlackBoxTestEvent<ApiJsonValue>): any {
    return {
        ...toPayloadRecord(event),
        closedAtEpochMs: event.atEpochMs,
        provider: 'rallar-remote-browser',
        actor: event.actor,
        transport: event.transport,
        commandId: event.commandId,
        event
    };
}

/** A WebSocket frame that carries JSON text is observed as the JSON value it encodes. */
function toRemoteWsMessageValue(frame: ApiJsonValue | undefined): ApiJsonValue | undefined {
    if (typeof frame !== 'string') {
        return frame;
    }
    try {
        const parsed: ApiJsonValue = JSON.parse(frame);
        return parsed;
    }
    catch {
        return frame;
    }
}

function isApiJsonObject(value: ApiJsonValue | undefined): value is ApiJsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
