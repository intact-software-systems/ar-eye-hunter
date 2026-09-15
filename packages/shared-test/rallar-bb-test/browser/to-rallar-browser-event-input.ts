import {
    inferRallarBlackBoxDiagnosticSeverity,
    normalizeRallarBlackBoxRuntimeDiagnostic
} from '../diagnostics.ts';
import type {
    RallarBlackBoxTestRuntimeEventInput
} from '../rallar-black-box-test-contracts.ts';

import { RallarBlackBoxBrowserRallarEvent } from './browser-command-contracts.ts';
import { toEventTransport } from './browser-command-values.ts';

export function toRallarBrowserEventInput(
    event: RallarBlackBoxBrowserRallarEvent
): RallarBlackBoxTestRuntimeEventInput {
    const kind = event.kind === 'message'
        ? 'message'
        : event.kind === 'close'
        ? 'event'
        : 'diagnostic';

    const payload = toRallarBrowserEventPayload(event);
    const severity = inferRallarBlackBoxDiagnosticSeverity({
        topic: event.topic ?? 'rallar.browser.event',
        severity: event.severity,
        error: event.error,
        data: event.data,
        payload
    });

    return {
        kind,
        topic: event.topic ?? 'rallar.browser.event',
        connection: event.connection,
        actor: event.actor,
        transport: toEventTransport(event.transport),
        severity: event.kind === 'message'
            ? 'info'
            : event.kind === 'close'
            ? 'warning'
            : severity,
        payload: kind === 'diagnostic'
            ? normalizeRallarBlackBoxRuntimeDiagnostic({
                topic: event.topic ?? 'rallar.browser.event',
                severity,
                transport: toEventTransport(event.transport),
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
                data: event.data,
                error: event.error,
                payload,
                source: 'browser-rallar-runtime'
            })
            : payload
    };
}

function toRallarBrowserEventPayload(
    event: RallarBlackBoxBrowserRallarEvent
): Pick<
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
    | 'data'
    | 'error'
> {
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
        data: event.data,
        error: event.error
    };
}
