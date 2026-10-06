import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import {
    EXPIRY_TTL_MS,
    MINIMUM_POST_EXPIRY_OBSERVATION_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    RESPONSE_MARGIN_MS
} from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import {
    toAdmissionCommands,
    toObserveCommand,
    toResultAssertion,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toAdmissionOutcomeWait, toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

/** `not-yet-in-sync` needs a carrier whose first hop is RTC: the receiver checks a room send's snapshot floor at RTC ingress. */
const RTC_CARRIERS: readonly AlmConformanceCarrier[] = ALM_CONFORMANCE_CARRIERS.filter((carrier) => carrier !== 'ws');
/** A floor no group reaches within a run, so the receiver refuses every copy until the message expires. */
const UNREACHABLE_SNAPSHOT_VERSION = 999_999;

/**
 * A send above every snapshot the group reaches. The receiver refuses each copy at admission and writes nothing; its
 * NACK schedules the sender's retries until the message expires. Delivery after the version advances is the
 * `fenced-catch-up` cell's.
 */
export const notYetInSync: AlmConformanceScenarioDefinition = {
    scenarioId: 'not-yet-in-sync',
    scenarioKey: 'not-yet-in-sync-expires',
    tags: FULL_TAGS,
    carriers: RTC_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toNotYetInSyncSenderCommands,
    toRecipientCommands: toNotYetInSyncReceiverCommands
};

function toNotYetInSyncSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, variant: 'expires' },
            delivery: {
                ack: 'receiver',
                reliability: 'at-least-once',
                ttlMs: EXPIRY_TTL_MS,
                minSnapshotVersion: { absolute: UNREACHABLE_SNAPSHOT_VERSION }
            }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({ ...sender, index: 1, state: 'expired' }),
        toResultAssertion({
            step: sender,
            name: 'assert-expired-1',
            resultName: 'observe-expired-1',
            field: 'state',
            operator: 'matches',
            expected: '^expired$'
        })
    ];
}

/** The refusal comes first, over RTC with the receiver's own not-yet-in-sync reason; then absence past the expiry. */
function toNotYetInSyncReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const windowMs = EXPIRY_TTL_MS + MINIMUM_POST_EXPIRY_OBSERVATION_MS;
    return [
        toAdmissionOutcomeWait(receiver, {
            name: 'not-yet-in-sync-outcome',
            contains: '"carrier":"rtc","outcome":"rejected","reason":"not-yet-in-sync',
            timeoutMs: receiver.input.deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS - RESPONSE_MARGIN_MS
        }),
        {
            ...toReceivedCommand({ ...receiver, index: 1, count: 1, absent: true }),
            windowMs,
            timeoutMs: windowMs + RESPONSE_MARGIN_MS
        }
    ];
}
