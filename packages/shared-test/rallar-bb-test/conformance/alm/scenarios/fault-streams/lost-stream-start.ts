import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_RTC_ALONE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { ALM_INBOUND_DIAGNOSTICS_TOPIC, toDiagnosticWait } from '../../alm-conformance-diagnostic-waits.ts';
import { toHeldMessageFaultCommands, toHeldSendCommands } from '../../alm-conformance-fault-commands.ts';
import { toObserveCommand, toResultAssertion } from '../../alm-conformance-message-commands.ts';
import {
    toOrderedSendCommands,
    toOrderingKey,
    toReachedCommands
} from '../../alm-conformance-ordering-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';

/**
 * A stated limit, not a guarantee: over `rtc` the first send of a new ordered track is lost for good when a later
 * send reaches the receiver before it. The receiver holds no state for the track, so it enters at the first frame it
 * sees and refuses the earlier one as before its entry: it cannot tell lost first frames from a late join. The receipt
 * stays truthful: the first send's handle ends `failed`, never `acknowledged`. The first send is held by its message
 * id, so no draw decides which frame is lost. Over `ws` the server orders the track and the first send arrives.
 */
export const lostStreamStart: AlmConformanceScenarioDefinition = {
    scenarioId: 'lost-stream-start',
    scenarioKey: 'lost-stream-start',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_RTC_ALONE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toLostStreamStartSenderCommands,
    toRecipientCommands: toLostStreamStartReceiverCommands
};

/** The hold is released only once the receiver confirmed sends 2 and 3: it has then entered the track past send 1. */
function toLostStreamStartSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const first = { ...sender, index: 1 };
    return [
        ...toHeldSendCommands(first, toOrderedSendCommands(sender, 1, 'receiver')),
        ...[2, 3].flatMap((seq) => [
            ...toOrderedSendCommands(sender, seq, 'receiver'),
            ...toReachedCommands({ ...sender, index: seq })
        ]),
        ...toHeldMessageFaultCommands(first, 'release-message-1', 0),
        toObserveCommand({ ...first, state: 'failed', budgetMs: NON_EXPIRING_SEND_TIMEOUT_MS }),
        toResultAssertion({
            step: sender,
            name: 'assert-receipt-exhausted-1',
            resultName: 'observe-failed-1',
            field: 'failure.kind',
            operator: 'equals',
            expected: 'receipt-exhausted'
        })
    ];
}

/**
 * Two arrivals in order, the refusal of the first send, then no third. One sender holds the cell's track, so the
 * ordering key alone names it.
 */
function toLostStreamStartReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({ ...receiver, index: 2, count: 2, absent: false, ascendingBy: 'seq' }),
        toDiagnosticWait({
            step: receiver,
            name: 'before-entry-1',
            topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
            historyFrom: 'cell',
            contains: `"trackKey":"${toOrderingKey(receiver)}:`,
            payloadFields: { 'data.kind': 'ordering-position', 'data.status': 'before-entry', 'data.seq': 1 }
        }),
        toReceivedCommand({ ...receiver, index: 3, count: 3, absent: true })
    ];
}
