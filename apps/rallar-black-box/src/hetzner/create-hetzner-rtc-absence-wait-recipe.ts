import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { toHetznerRoomProofCommands } from './hetzner-room-proof-commands.ts';

const CONTROL_TOPIC = 'black-box.absence.control';
const LEAK_PROBE_TOPIC = 'black-box.absence.leak-probe';
const ENSURE_GROUP_REQUEST_ID = 'd23699bb-0a36-4076-8fab-10c942115141-{runtimeIdentity}';
const ENSURE_MEMBER_REQUEST_ID = '595968fc-482e-4ef5-8125-565007433507-{runtimeIdentity}';

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
    return {
        schemaVersion: 1,
        recipeId: 'rtc-absence-wait-recipe',
        name: 'RTC absence wait recipe',
        continueOnFailure: false,
        metadata: {
            profile: 'rtc-absence',
            group: roomRef
        },
        commands: [
            ...toHetznerRoomProofCommands({
                group: roomRef,
                prefix: 'rtc-absence',
                connection: 'absenceRtc',
                controlTopic: CONTROL_TOPIC,
                leakProbeTopic: LEAK_PROBE_TOPIC,
                groupRequestId: ENSURE_GROUP_REQUEST_ID,
                memberRequestId: ENSURE_MEMBER_REQUEST_ID,
                absencePurpose: 'No agent may ever observe a leak-probe frame on this connection.'
            }),
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
