import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import {
    EXPIRY_TTL_MS,
    MINIMUM_POST_EXPIRY_OBSERVATION_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    NON_EXPIRING_TTL_MS,
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
const NOT_YET_IN_SYNC_VARIANTS = ['delivered-after-refresh', 'expires'] as const;
/** A floor no group reaches within a run, so the receiver refuses every copy until the message expires. */
const UNREACHABLE_SNAPSHOT_VERSION = 999_999;

export const notYetInSync: readonly AlmConformanceScenarioDefinition[] = NOT_YET_IN_SYNC_VARIANTS.map((variant) => ({
    scenarioId: 'not-yet-in-sync' as const,
    scenarioKey: `not-yet-in-sync-${variant}`,
    tags: FULL_TAGS,
    carriers: RTC_CARRIERS,
    toSenderCommands: (sender: AlmConformanceStepInput) => toNotYetInSyncSenderCommands(sender, variant),
    toReceiverCommands: (receiver: AlmConformanceStepInput) => toNotYetInSyncReceiverCommands(receiver, variant)
}));

/**
 * A send above the receiver's room snapshot. The receiver refuses it at admission and writes nothing; its NACK
 * schedules the sender's retries (D35). `delivered-after-refresh` states a floor one past the sender's own version,
 * so it proves NACK → retry → delivery once the group version advances; the sender proves only its own hop evidence
 * (D28). Today no plain-member write advances that version, so the variant is a named red at the receiver's
 * `received-1` (ruling e). `expires` states a floor no group reaches, so every copy is refused until it expires.
 */
function toNotYetInSyncSenderCommands(
    sender: AlmConformanceStepInput,
    variant: (typeof NOT_YET_IN_SYNC_VARIANTS)[number]
): readonly RallarBlackBoxTestCommand[] {
    const expires = variant === 'expires';
    const send = toSendCommand({
        ...sender,
        index: 1,
        payload: { marker: sender.scenarioId, variant },
        delivery: {
            ack: 'receiver',
            reliability: 'at-least-once',
            ...(expires
                ? { ttlMs: EXPIRY_TTL_MS, minSnapshotVersion: { absolute: UNREACHABLE_SNAPSHOT_VERSION } }
                : {
                    ttlMs: NON_EXPIRING_TTL_MS,
                    commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS,
                    minSnapshotVersion: { aboveCurrentBy: 1 }
                })
        }
    });
    const state = expires ? 'expired' : 'transport-accepted';
    return [
        send,
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({ ...sender, index: 1, state }),
        toResultAssertion({
            step: sender,
            name: `assert-${state}-1`,
            resultName: `observe-${state}-1`,
            field: 'state',
            operator: 'matches',
            expected: expires ? '^expired$' : '^(transport-accepted|acknowledged)$'
        })
    ];
}

/**
 * The refusal comes first: over RTC, with the receiver's own not-yet-in-sync reason. Then one delivery, or absence
 * for the rest of the message's lifetime and past it.
 */
function toNotYetInSyncReceiverCommands(
    receiver: AlmConformanceStepInput,
    variant: (typeof NOT_YET_IN_SYNC_VARIANTS)[number]
): readonly RallarBlackBoxTestCommand[] {
    const refusal = toAdmissionOutcomeWait(receiver, {
        name: 'not-yet-in-sync-outcome',
        contains: '"carrier":"rtc","outcome":"rejected","reason":"not-yet-in-sync',
        timeoutMs: receiver.input.deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS - RESPONSE_MARGIN_MS
    });
    if (variant === 'delivered-after-refresh') {
        return [refusal, toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false })];
    }
    const windowMs = EXPIRY_TTL_MS + MINIMUM_POST_EXPIRY_OBSERVATION_MS;
    return [
        refusal,
        {
            ...toReceivedCommand({ ...receiver, index: 1, count: 1, absent: true }),
            windowMs,
            timeoutMs: windowMs + RESPONSE_MARGIN_MS
        }
    ];
}
