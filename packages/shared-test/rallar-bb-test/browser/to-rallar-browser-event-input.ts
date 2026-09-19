import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import {
    computeRallarBlackBoxDiagnosticSeverity,
    toRallarBlackBoxRuntimeDiagnostic,
    type RallarBlackBoxRuntimeDiagnosticPayload
} from '../diagnostics.ts';
import type {
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestSeverity
} from '../rallar-black-box-test-contracts.ts';
import { decodeJsonValue } from '../runtime/decode-runtime-result-values.ts';

import type { RallarBlackBoxBrowserRallarEvent } from './browser-command-contracts.ts';

interface RallarBrowserEventPayload extends
    Pick<
        RallarBlackBoxBrowserRallarEvent,
        | 'roomId'
        | 'roomRef'
        | 'scope'
        | 'applicationId'
        | 'workspaceId'
        | 'laneId'
        | 'peerId'
        | 'remotePeerId'
        | 'senderId'
        | 'typeId'
        | 'topicId'
        | 'contextId'
        | 'resourceId'
        | 'error'
    > {
    /** Absent when the event carries no data with a JSON form. */
    readonly data: ApiJsonValue | undefined;
}

const DEFAULT_RALLAR_BROWSER_EVENT_TOPIC = 'rallar.browser.event';

export function toRallarBrowserEventInput(
    event: RallarBlackBoxBrowserRallarEvent
): RallarBlackBoxTestRuntimeEventInput {
    const topic = event.topic ?? DEFAULT_RALLAR_BROWSER_EVENT_TOPIC;
    const payload = toRallarBrowserEventPayload(event);
    const base = { topic, connection: event.connection, actor: event.actor, transport: event.transport };
    if (event.kind === 'message') {
        return { ...base, kind: 'message', severity: 'info', payload };
    }
    if (event.kind === 'close') {
        return { ...base, kind: 'event', severity: 'warning', payload };
    }
    const severity = computeRallarBlackBoxDiagnosticSeverity({
        topic,
        severity: event.severity,
        error: event.error,
        detail: payload.data,
        payload
    });
    return {
        ...base,
        kind: 'diagnostic',
        severity,
        payload: toRallarBrowserDiagnosticPayload(event, payload, severity)
    };
}

function toRallarBrowserDiagnosticPayload(
    event: RallarBlackBoxBrowserRallarEvent,
    payload: RallarBrowserEventPayload,
    severity: RallarBlackBoxTestSeverity
): RallarBlackBoxRuntimeDiagnosticPayload {
    return toRallarBlackBoxRuntimeDiagnostic({
        topic: event.topic ?? DEFAULT_RALLAR_BROWSER_EVENT_TOPIC,
        severity,
        transport: event.transport,
        connection: event.connection,
        actor: event.actor,
        roomId: event.roomId,
        laneId: event.laneId,
        peerId: event.peerId,
        remotePeerId: event.remotePeerId,
        senderId: event.senderId,
        typeId: event.typeId,
        topicId: event.topicId,
        contextId: event.contextId,
        resourceId: event.resourceId,
        atEpochMs: event.atEpochMs,
        detail: payload.data,
        error: event.error,
        payload,
        source: 'browser-rallar-runtime'
    });
}

function toRallarBrowserEventPayload(event: RallarBlackBoxBrowserRallarEvent): RallarBrowserEventPayload {
    return {
        roomId: event.roomId,
        roomRef: event.roomRef,
        scope: event.scope,
        applicationId: event.applicationId,
        workspaceId: event.workspaceId,
        laneId: event.laneId,
        peerId: event.peerId,
        remotePeerId: event.remotePeerId,
        senderId: event.senderId,
        typeId: event.typeId,
        topicId: event.topicId,
        contextId: event.contextId,
        resourceId: event.resourceId,
        data: decodeJsonValue(event.data),
        error: event.error
    };
}
