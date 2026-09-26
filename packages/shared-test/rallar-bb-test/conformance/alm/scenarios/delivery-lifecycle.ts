import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import { toHeldFaultCommands } from '../alm-conformance-fault-commands.ts';
import {
    toAdmissionCommands,
    toCancelCommand,
    toObserveCommand,
    toReceiptsCommand,
    toResultAssertion,
    toRetainedEvidenceCommands,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toPayloadWait } from '../alm-conformance-receiver-commands.ts';
import {
    SMOKE_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

export const deliveryLifecycle: AlmConformanceScenarioDefinition = {
    scenarioId: 'delivery-lifecycle',
    scenarioKey: 'delivery-lifecycle',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    toSenderCommands: toDeliveryLifecycleSenderCommands,
    toReceiverCommands: toDeliveryLifecycleReceiverCommands
};

/** Each retained specimen explicitly releases its own hold; recipe failure uses runtime cleanup. */
function toDeliveryLifecycleSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toSubmissionSpecimenCommands(sender),
        ...toRetainedCancellationCommands(sender),
        ...toSupersedenceCommands(sender),
        ...toSubmissionReceiptCommands(sender)
    ];
}

/**
 * D28: the receiver's own wait is the local receipt for the submission, so the sender only proves
 * carrier-level submission here; `toSubmissionReceiptCommands` reads the sender's receipts and
 * releases the handle afterwards, once the whole scenario has elapsed.
 */
function toSubmissionSpecimenCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const state = 'transport-accepted';
    const observation = `observe-${state}-1`;
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: toLifecyclePayload(sender, 'submission'),
            delivery: { ack: 'receiver' }
        }),
        toObserveCommand({ ...sender, index: 1, state }),
        toResultAssertion({
            step: sender,
            name: 'assert-submitted-state-1',
            resultName: observation,
            field: 'state',
            operator: 'matches',
            expected: '^(transport-accepted|acknowledged)$'
        }),
        toResultAssertion({
            step: sender,
            name: 'assert-submitted-1',
            resultName: observation,
            field: 'submitted',
            operator: 'equals',
            expected: true
        })
    ];
}

/**
 * A ws receipt confirms logical recipients and names no hop, so its recipient lists are read; an rtc receipt
 * confirms hops. Which peer the ws receipt confirms is joined to the session of the receiver by
 * `assessAlmAcknowledgedIdentity`.
 */
function toSubmissionReceiptCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const isWs = sender.input.carrier === 'ws';
    const peerLists = isWs ? 'RecipientPeerIds' : 'HopPeerIds';
    return [
        toReceiptsCommand({ ...sender, index: 1 }),
        toResultAssertion({
            step: sender,
            name: 'assert-confirmed-1',
            resultName: 'receipts-1',
            field: `confirmed${peerLists}.length`,
            operator: isWs ? 'equals' : 'gt',
            expected: isWs ? 1 : 0
        }),
        toResultAssertion({
            step: sender,
            name: 'assert-unconfirmed-1',
            resultName: 'receipts-1',
            field: `unconfirmed${peerLists}.length`,
            operator: 'equals',
            expected: 0
        }),
        ...toSubmittedCancellationCommands(sender)
    ];
}

function toSubmittedCancellationCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toCancelCommand({ ...sender, index: 1 }),
        toResultAssertion({
            step: sender,
            name: 'assert-submitted-after-cancel-1',
            resultName: 'cancel-1',
            field: 'submitted',
            operator: 'equals',
            expected: true
        }),
        toResultAssertion({
            step: sender,
            name: 'assert-state-after-cancel-1',
            resultName: 'cancel-1',
            field: 'state',
            operator: 'matches',
            expected: '^acknowledged$'
        })
    ];
}

function toRetainedCancellationCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toHeldFaultCommands(sender, 'cancel-hold', 'until-cleared'),
        toSendCommand({
            ...sender,
            index: 2,
            payload: toLifecyclePayload(sender, 'cancellation'),
            delivery: { ack: 'receiver' }
        }),
        ...toRetainedEvidenceCommands({ ...sender, index: 2 }),
        toCancelCommand({ ...sender, index: 2 }),
        toResultAssertion({
            step: sender,
            name: 'assert-cancelled-2',
            resultName: 'cancel-2',
            field: 'state',
            operator: 'equals',
            expected: 'cancelled'
        }),
        ...toHeldFaultCommands(sender, 'cancel-release', 0)
    ];
}

function toSupersedenceCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toHeldFaultCommands(sender, 'supersede-hold', 'until-cleared'),
        toSendCommand({
            ...sender,
            index: 3,
            payload: toLifecyclePayload(sender, 'supersedence', 'old'),
            delivery: { ack: 'receiver' }
        }),
        ...toRetainedEvidenceCommands({ ...sender, index: 3 }),
        toSendCommand({
            ...sender,
            index: 4,
            payload: toLifecyclePayload(sender, 'supersedence', 'replacement'),
            delivery: { ack: 'receiver' }
        }),
        ...toAdmissionCommands({ ...sender, index: 4 }),
        toObserveCommand({ ...sender, index: 3, state: 'superseded' }),
        toResultAssertion({
            step: sender,
            name: 'assert-superseded-3',
            resultName: 'observe-superseded-3',
            field: 'state',
            operator: 'equals',
            expected: 'superseded'
        }),
        ...toHeldFaultCommands(sender, 'supersede-release', 0),
        ...toReplacementSubmittedCommands(sender)
    ];
}

/**
 * The receiver proves the replacement arrived. Hold release only makes that send possible, so the
 * sender stays up until the replacement is actually submitted.
 */
function toReplacementSubmittedCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const state = 'transport-accepted';
    const observation = `observe-${state}-4`;
    return [
        toObserveCommand({ ...sender, index: 4, state }),
        toResultAssertion({
            step: sender,
            name: 'assert-replacement-submitted-4',
            resultName: observation,
            field: 'submitted',
            operator: 'equals',
            expected: true
        })
    ];
}

function toDeliveryLifecycleReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toPayloadWait({
            step: receiver,
            name: 'receive-submission',
            payload: toLifecyclePayload(receiver, 'submission'),
            absent: false
        }),
        toPayloadWait({
            step: receiver,
            name: 'absent-cancelled',
            payload: toLifecyclePayload(receiver, 'cancellation'),
            absent: true
        }),
        toPayloadWait({
            step: receiver,
            name: 'receive-replacement',
            payload: toLifecyclePayload(receiver, 'supersedence', 'replacement'),
            absent: false
        }),
        toPayloadWait({
            step: receiver,
            name: 'absent-old',
            payload: toLifecyclePayload(receiver, 'supersedence', 'old'),
            absent: true
        })
    ];
}

function toLifecyclePayload(
    step: AlmConformanceStepInput,
    specimen: 'submission' | 'cancellation' | 'supersedence',
    revision?: 'old' | 'replacement'
): Readonly<Record<string, string>> {
    return { marker: 'delivery-lifecycle', specimen, carrier: step.input.carrier, ...(revision ? { revision } : {}) };
}
