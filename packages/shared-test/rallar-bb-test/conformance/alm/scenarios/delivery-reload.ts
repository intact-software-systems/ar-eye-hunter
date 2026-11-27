import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import { toHeldFaultCommands } from '../alm-conformance-fault-commands.ts';
import {
    toObserveCommand,
    toResultAssertion,
    toRetainedEvidenceCommands,
    toSendCommand,
    toStorageCountersCommand
} from '../alm-conformance-message-commands.ts';
import { toPayloadWait } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import {
    RECOVERED_STORE_PREFIXES,
    toOriginalStorePrefix,
    toRecoveryTtlMs,
    toStoreRecoveryWait
} from '../alm-conformance-session-commands.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';
import {
    toAlmReloadCheckpoint,
    toReloadCommand,
    toReloadPhaseHealthCommand,
    toRestoredReconnectCommand
} from '../cell/to-alm-reload-checkpoint.ts';

export const deliveryReload: AlmConformanceScenarioDefinition = {
    scenarioId: 'delivery-reload',
    scenarioKey: 'delivery-reload',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toDeliveryReloadSenderCommands,
    toRecipientCommands: toDeliveryReloadReceiverCommands,
    toReloadCheckpoint: (step) =>
        toAlmReloadCheckpoint(step, {
            senderPrefixEnd: 'assert-storage-write',
            senderSuffixEnd: 'storage-counters-recovered',
            receiverReadyEnd: 'health-before',
            receiverAbsenceEnd: 'absent-before-reload',
            receiverRecoveryEnd: 'health-after'
        })
};

/** The native hold ends only with the old document; the fresh runtime restores the original durable work. */
function toDeliveryReloadSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toReloadPhaseHealthCommand(sender, 'health-before'),
        ...toHeldFaultCommands(sender, 'reload-hold', 'until-cleared'),
        toReloadOriginalSend(sender),
        ...toRetainedEvidenceCommands({ ...sender, index: 1 }, true),
        toStorageCountersCommand(sender, 'storage-counters-held', false),
        ...(['al-admission', 'al-work'] as const).map((owner) =>
            toResultAssertion({
                step: sender,
                name: `assert-storage-${owner}`,
                resultName: 'storage-counters-held',
                field: `byOwner.${owner}`,
                operator: 'gt',
                expected: 0
            })
        ),
        toResultAssertion({
            step: sender,
            name: 'assert-storage-write',
            resultName: 'storage-counters-held',
            field: 'byKind.write',
            operator: 'gt',
            expected: 0
        }),
        toReloadCommand(sender),
        toRestoredReconnectCommand(sender),
        toObserveCommand({ ...sender, index: 1, state: 'unobservable' }),
        toResultAssertion({
            step: sender,
            name: 'assert-old-handle-unobservable',
            resultName: 'observe-unobservable-1',
            field: 'state',
            operator: 'equals',
            expected: 'unobservable'
        }),
        ...toRecoveredStoreWaits(sender),
        toStorageCountersCommand(sender, 'storage-counters-recovered', false)
    ];
}

/**
 * One `restored` outcome for the session inbound store and for the outbound store holding the original. The session
 * inbound store is shared by both carriers' lanes and reports per lane; the WS lane runs on every carrier, so its
 * outcome is the one read. The fallback carrier's hold hands the original to WS before the reload, so only `rtc`
 * leaves it in the overlay store. That no store also read `storage-created` or `storage-reset` rests on each lane
 * reporting once.
 */
function toRecoveredStoreWaits(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const timeoutMs = toRecoveryTtlMs(sender.input.deadlineMs);
    return [
        toStoreRecoveryWait(sender, {
            name: 'recovered-session-inbound',
            storeIdPrefix: RECOVERED_STORE_PREFIXES.sessionInbound,
            lane: '/ws',
            connectName: 'reconnect',
            historyFrom: 'page',
            timeoutMs
        }),
        toStoreRecoveryWait(sender, {
            name: 'recovered-original-store',
            storeIdPrefix: toOriginalStorePrefix(sender.input.carrier),
            lane: '',
            connectName: 'reconnect',
            historyFrom: 'page',
            timeoutMs
        })
    ];
}

function toReloadOriginalSend(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return toSendCommand({
        ...sender,
        index: 1,
        payload: { marker: 'delivery-reload', carrier: sender.input.carrier },
        delivery: {
            ack: 'receiver',
            durability: 'local-outbox',
            ttlMs: toRecoveryTtlMs(sender.input.deadlineMs),
            commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
        }
    });
}

function toDeliveryReloadReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const payload = { marker: 'delivery-reload', carrier: receiver.input.carrier };
    return [
        toReloadPhaseHealthCommand(receiver, 'health-before'),
        toPayloadWait({ step: receiver, name: 'absent-before-reload', payload, absent: true }),
        toPayloadWait({ step: receiver, name: 'receive-original', payload, absent: false }),
        toReloadPhaseHealthCommand(receiver, 'health-after')
    ];
}
