import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { CONNECT_TIMEOUT_MS, NON_EXPIRING_SEND_TIMEOUT_MS } from '../../alm-conformance-budgets.ts';
import { toHeldFaultCommands } from '../../alm-conformance-fault-commands.ts';
import {
    toResultAssertion,
    toRetainedEvidenceCommands,
    toSendCommand,
    toStorageCountersCommand
} from '../../alm-conformance-message-commands.ts';
import { toPayloadWait, toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import {
    toCheckpointStorePrefix,
    toRecoveryTtlMs,
    toStoreRecoveryWait
} from '../../alm-conformance-session-commands.ts';

/**
 * The page's lifecycle flush saves what the interval has not: the owner page holds its carrier, admits one original
 * from memory and ends its recipe at once, inside the interval; the lane then fires the page's `freeze` event and
 * crashes it, so no `pagehide` flush and no interval write follows. The owner's last command reads the storage
 * counters it reset before the send, so a page the interval wrote on before it ended fails here instead of proving
 * the interval's write as the flush's. The successor, a second page of the same context and session, restores the
 * row from the checkpoint store and delivers it once. Over the fallback carrier a held original moves to the WS lane
 * at a moment the lane cannot see, so which store holds it when the page ends is open: the scenario runs over `ws`
 * and `rtc`.
 */
export const flushOnHide: AlmConformanceScenarioDefinition = {
    scenarioId: 'flush-on-hide',
    scenarioKey: 'flush-on-hide',
    tags: FULL_TAGS,
    carriers: ['ws', 'rtc'],
    roles: ['sender', 'receiver', 'successor'],
    laneFamily: 'same-context',
    toSenderCommands: (page) => page.role === 'successor' ? toSuccessorCommands(page) : toOwnerCommands(page),
    toRecipientCommands: toFlushOnHideReceiverCommands
};

function toOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toHeldFaultCommands(owner, 'flush-hold', 'until-cleared'),
        toStorageCountersCommand(owner, 'storage-counters-before-send', true),
        toSendCommand({
            ...owner,
            index: 1,
            payload: toPayload(owner),
            delivery: {
                ack: 'receiver',
                durability: 'local-checkpoint',
                ttlMs: toRecoveryTtlMs(owner.input.deadlineMs),
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
            }
        }),
        ...toRetainedEvidenceCommands({ ...owner, index: 1 }, true),
        ...toUnflushedWitnessCommands(owner)
    ];
}

/**
 * The send path writes nothing, so a write counted since the reset before the send is the interval's checkpoint. The
 * counters are sparse: a kind never counted is absent, and the witness is that absence.
 */
function toUnflushedWitnessCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toStorageCountersCommand(owner, 'storage-counters-unflushed', false),
        toResultAssertion({
            step: owner,
            name: 'assert-no-interval-write',
            resultName: 'storage-counters-unflushed',
            field: 'byKind.write',
            operator: 'exists',
            expected: false
        })
    ];
}

/** The flushed row is held reserved under a lease, so the successor's prologue waits that lease out before it connects. */
function toSuccessorCommands(successor: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toStoreRecoveryWait(successor, {
            name: 'recovered-checkpoint-store',
            storeIdPrefix: toCheckpointStorePrefix(successor.input.carrier),
            lane: '',
            connectName: 'connect',
            timeoutMs: toRecoveryTtlMs(successor.input.deadlineMs)
        }),
        toResultAssertion({
            step: successor,
            name: 'assert-recovered-claimed',
            resultName: 'recovered-checkpoint-store',
            field: 'event.payload.data.outcome.claimed',
            operator: 'gt',
            expected: 0
        })
    ];
}

function toFlushOnHideReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        {
            ...toPayloadWait({ step: receiver, name: 'receive-original', payload: toPayload(receiver), absent: false }),
            timeoutMs: CONNECT_TIMEOUT_MS + toRecoveryTtlMs(receiver.input.deadlineMs)
        },
        toReceivedCommand({ ...receiver, index: 1, count: 2, absent: true })
    ];
}

/** The payload names its carrier, so a wait never matches another carrier's cell. */
function toPayload(step: AlmConformanceStepInput): Readonly<Record<string, string>> {
    return { marker: step.scenarioId, carrier: step.input.carrier };
}
