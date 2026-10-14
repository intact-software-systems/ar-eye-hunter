import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import {
    CONNECT_READINESS_TIMEOUT_MS,
    CONNECT_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    STATS_TIMEOUT_MS
} from '../alm-conformance-budgets.ts';
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
    RESTORED_SESSION_RALLAR,
    toConnectCommand,
    toOriginalStorePrefix,
    toRecoveryTtlMs,
    toStoreRecoveryWait
} from '../alm-conformance-session-commands.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';
import type { AlmReloadCheckpoint } from '../alm-reload-pair.ts';

export const deliveryReload: AlmConformanceScenarioDefinition = {
    scenarioId: 'delivery-reload',
    scenarioKey: 'delivery-reload',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toDeliveryReloadSenderCommands,
    toRecipientCommands: toDeliveryReloadReceiverCommands,
    toReloadCheckpoint
};

function toReloadCheckpoint(step: AlmConformanceStepInput): AlmReloadCheckpoint {
    const sender = { ...step, role: 'sender' as const };
    const receiver = { ...step, role: 'receiver' as const };
    return {
        key: `alm-${step.input.carrier}-delivery-reload`,
        senderPrefixEnd: toCommandId(sender, 'assert-storage-write'),
        senderReload: toCommandId(sender, 'reload'),
        senderSuffixEnd: toCommandId(sender, 'storage-counters-recovered'),
        receiverReadyEnd: toCommandId(receiver, 'health-before'),
        receiverAbsenceEnd: toCommandId(receiver, 'absent-before-reload'),
        receiverRecoveryEnd: toCommandId(receiver, 'health-after')
    };
}

/** The native hold ends only with the old document; the fresh runtime restores the original durable work. */
function toDeliveryReloadSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const reconnect = toConnectCommand(sender);
    return [
        toReloadHealthCommand(sender, 'health-before'),
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
        {
            kind: 'agent.reload',
            commandId: toCommandId(sender, 'reload'),
            readyTimeoutMs: CONNECT_READINESS_TIMEOUT_MS,
            timeoutMs: CONNECT_TIMEOUT_MS
        },
        {
            ...reconnect,
            commandId: toCommandId(sender, 'reconnect'),
            rallar: { ...reconnect.rallar, ...RESTORED_SESSION_RALLAR }
        },
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
            timeoutMs
        }),
        toStoreRecoveryWait(sender, {
            name: 'recovered-original-store',
            storeIdPrefix: toOriginalStorePrefix(sender.input.carrier),
            lane: '',
            connectName: 'reconnect',
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
        toReloadHealthCommand(receiver, 'health-before'),
        toPayloadWait({ step: receiver, name: 'absent-before-reload', payload, absent: true }),
        toPayloadWait({ step: receiver, name: 'receive-original', payload, absent: false }),
        toReloadHealthCommand(receiver, 'health-after')
    ];
}

function toReloadHealthCommand(step: AlmConformanceStepInput, name: string): RallarBlackBoxTestCommand {
    return { kind: 'health', commandId: toCommandId(step, name), timeoutMs: STATS_TIMEOUT_MS };
}
