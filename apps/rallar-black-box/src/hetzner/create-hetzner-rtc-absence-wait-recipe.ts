import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/types.ts';

const CONTROL_TOPIC = 'black-box.absence.control';
const LEAK_PROBE_TOPIC = 'black-box.absence.leak-probe';
const ENSURE_GROUP_REQUEST_ID = 'd23699bb-0a36-4076-8fab-10c942115141-{runId}';
const ENSURE_MEMBER_REQUEST_ID = '595968fc-482e-4ef5-8125-565007433507-{runId}';

// The Hetzner isolation contract pins every identity in a manifest to one
// effective group, so the absence claims stay inside that room: the delivered
// control topic proves transport health, then the run asserts no leak-probe
// frame and no silent rtc send failure ever surfaced on the same connection.
export function createHetznerRtcAbsenceWaitRecipe(
    group: RallarBlackBoxDistributedGroupRef
): RallarBlackBoxTestRecipe {
    const roomRef = {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId
    };
    const statePrefix = `/api/state/apps/${group.applicationId}/workspaces/${group.workspaceId}`;

    return {
        recipeId: 'rtc-absence-wait-recipe',
        name: 'RTC absence wait recipe',
        continueOnFailure: false,
        metadata: {
            profile: 'rtc-absence',
            group: roomRef
        },
        commands: [
            {
                kind: 'http.request',
                commandId: 'rtc-absence-ensure-group',
                timeoutMs: 5_000,
                metadata: {
                    purpose: 'Ensure the backend group exists before RTC room join.',
                    idempotent: true,
                    group: roomRef
                },
                request: {
                    method: 'POST',
                    path: `${statePrefix}/groups/requests/${ENSURE_GROUP_REQUEST_ID}`,
                    body: {
                        groupId: group.groupId,
                        displayName: group.groupId,
                        kind: 'room',
                        joinMode: 'open'
                    }
                },
                response: {
                    body: 'json',
                    acceptedStatusCodes: [200, 201, 409]
                }
            },
            {
                kind: 'http.request',
                commandId: 'rtc-absence-ensure-member',
                timeoutMs: 5_000,
                metadata: {
                    purpose: 'Ensure the logged-in browser client is an active group member ' +
                        'before RTC room join.',
                    idempotent: true,
                    group: roomRef
                },
                request: {
                    method: 'PUT',
                    path: `${statePrefix}/groups/${group.groupId}/members/{auth.clientId}` +
                        `/requests/${ENSURE_MEMBER_REQUEST_ID}`,
                    body: {
                        status: 'active'
                    }
                },
                response: {
                    body: 'json',
                    acceptedStatusCodes: [200, 201]
                }
            },
            {
                kind: 'rtc.connect',
                commandId: 'rtc-absence-connect',
                connection: 'absenceRtc',
                actor: '{auth.clientId}',
                roomId: group.groupId,
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                roomRef,
                transport: 'realtime',
                timeoutMs: 15_000,
                readiness: {
                    minReadyPeers: 1,
                    timeoutMs: 10_000,
                    intervalMs: 100
                }
            },
            {
                kind: 'rtc.send',
                commandId: 'rtc-absence-send-control',
                connection: 'absenceRtc',
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                roomRef,
                transport: 'realtime',
                send: {
                    roomId: group.groupId,
                    roomRef,
                    data: {
                        topic: CONTROL_TOPIC,
                        marker: 'same-room-positive-control',
                        actor: '{auth.clientId}'
                    }
                },
                timeoutMs: 3_000
            },
            {
                kind: 'wait',
                commandId: 'rtc-absence-positive-control',
                timeoutMs: 10_000,
                metadata: {
                    purpose: 'Same-room positive control: the control frame must arrive ' +
                        'before any absence claim.'
                },
                match: {
                    kind: 'message',
                    connection: 'absenceRtc',
                    topic: 'rallar.browser.realtime.message',
                    payloadPath: 'data.topic',
                    equals: CONTROL_TOPIC
                }
            },
            {
                kind: 'wait',
                commandId: 'rtc-absence-no-leak-probe',
                absent: true,
                timeoutMs: 4_000,
                metadata: {
                    purpose: 'No agent may ever observe a leak-probe frame on this connection.'
                },
                match: {
                    kind: 'message',
                    connection: 'absenceRtc',
                    topic: 'rallar.browser.realtime.message',
                    payloadPath: 'data.topic',
                    equals: LEAK_PROBE_TOPIC
                }
            },
            {
                kind: 'wait',
                commandId: 'rtc-absence-no-send-failures',
                absent: true,
                timeoutMs: 2_000,
                metadata: {
                    purpose: 'No silent rtc send failure may exist anywhere in the run buffer.'
                },
                match: {
                    kind: 'diagnostic',
                    topic: 'rallar.bb.rtc.send_failed'
                }
            },
            {
                kind: 'stats',
                commandId: 'rtc-absence-stats'
            }
        ]
    };
}
