import { BlackBoxRallarRuntimeDiagnostics } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts';
import type { BlackBoxRallarConnectionConfig } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import { BlackBoxRallarTypedChannels } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-typed-channels.ts';
import { createBlackBoxRallarMessagingResourceController } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/create-black-box-rallar-messaging-resource-controller.ts';
import { toRallarBrowserEventInput } from '@shared-test/rallar-bb-test/browser/to-rallar-browser-event-input.ts';
import { toControlEventEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/mod.ts';
import type { RallarMessage, RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { newALMulticastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';

import type { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';

export interface RecordedRtcMessageEventInput {
    readonly runId: string;
    readonly agentId: string;
    readonly payload: RallarMessagePayload;
}

const ROOM_REF = { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'live-rtc-room' };

const CONFIG: BlackBoxRallarConnectionConfig = {
    connection: 'receiver-messages-rtc',
    roomId: ROOM_REF.groupId,
    roomRef: ROOM_REF,
    rallar: {
        apiBaseUrl: 'http://fixture.invalid',
        applicationId: ROOM_REF.applicationId,
        workspaceId: ROOM_REF.workspaceId,
        transport: 'messages.rtc',
        typeId: 'live-rtc.matrix'
    }
};

/**
 * The control event a receiving page records for an RTC arrival, produced by the browser's own message recorder and
 * carried through the page's event normalization and the control envelope, as the control server returns it.
 */
export function createRecordedRtcMessageEvent(input: RecordedRtcMessageEventInput): LiveRtcControlClient.Event {
    const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({ now: () => 100 });
    const diagnostics = new BlackBoxRallarRuntimeDiagnostics({
        now: () => 100,
        publish: (event) =>
            runtime.recordEvent(toRallarBrowserEventInput({
                ...event,
                roomRef: event.roomRef ? { ...event.roomRef } : undefined,
                scope: event.scope ? { ...event.scope } : undefined
            })),
        onPublishError: (error) => {
            throw error;
        },
        transportOf: () => 'messages.rtc',
        laneIdOf: () => 'messages.rtc',
        scopeDiagnostics: () => ({})
    });
    const typedChannels = new BlackBoxRallarTypedChannels({
        messages: { room: unused, readUsage: unused, rtc: { send: unused, onMessage: unused }, ws: { send: unused, onMessage: unused } },
        connection: { session: () => undefined },
        resources: createBlackBoxRallarMessagingResourceController({ generation: () => 1, isCurrent: () => true }),
        diagnostics
    });
    const message = toRtcArrival(input.payload);
    typedChannels.toElectionHandler(CONFIG)(message.payload, message);
    const [recorded] = runtime.state().events;
    return JSON.parse(JSON.stringify(toControlEventEnvelope(recorded, input.runId, input.agentId)));
}

function toRtcArrival(payload: RallarMessagePayload): RallarMessage<RallarMessagePayload> {
    const route = newALRoute('live-rtc', ROOM_REF.groupId, 'live-rtc-message');
    const raw = newALMulticastMessage('session-sender', route, ROOM_REF, 'live-rtc.matrix', payload, { rosterVersion: 3 });
    return {
        transport: 'rtc',
        typeId: raw.payload.typeId,
        topicId: raw.route.topicId,
        contextId: raw.route.contextId,
        resourceId: raw.route.resourceId,
        roomId: ROOM_REF.groupId,
        senderId: raw.id.senderId,
        traceId: raw.id.traceId,
        payload,
        raw,
        receivedAtEpochMs: 100,
        reply: unused
    };
}

function unused(): never {
    throw new Error('The recorded RTC message fixture only records an arrival.');
}
