import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import {
    CONNECT_READINESS_TIMEOUT_MS,
    CONNECT_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    RESPONSE_MARGIN_MS,
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
import { toConnectCommand } from '../alm-conformance-session-commands.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';
import type { AlmReloadCheckpoint } from '../alm-reload-pair.ts';

/**
 * The browser fills an omitted TTL with 30 seconds. The absence proof, the
 * document replacement, and one reserved-work lease consume that before the
 * fresh runtime can submit, so the reload original states a longer lifetime.
 */
const RELOAD_RECOVERY_MARGIN_MS = 60_000;

export const deliveryReload: AlmConformanceScenarioDefinition = {
    scenarioId: 'delivery-reload',
    scenarioKey: 'delivery-reload',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    toSenderCommands: toDeliveryReloadSenderCommands,
    toRecipientCommands: toDeliveryReloadReceiverCommands
};

export function toReloadCheckpoint(step: AlmConformanceStepInput): AlmReloadCheckpoint {
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
        ...toRetainedEvidenceCommands({ ...sender, index: 1 }),
        toStorageCountersCommand(sender, 'storage-counters-held'),
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
            rallar: { ...reconnect.rallar, username: '', password: '', restoreSession: true }
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
        toStorageCountersCommand(sender, 'storage-counters-recovered')
    ];
}

function toReloadOriginalSend(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return toSendCommand({
        ...sender,
        index: 1,
        payload: { marker: 'delivery-reload', carrier: sender.input.carrier },
        delivery: {
            ack: 'receiver',
            ttlMs: toReloadSurvivalTtlMs(sender.input.deadlineMs),
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

/** The absence window plus the time a reloaded owner needs before it can submit. */
function toReloadSurvivalTtlMs(deadlineMs: number): number {
    return deadlineMs - RESPONSE_MARGIN_MS + RELOAD_RECOVERY_MARGIN_MS;
}
