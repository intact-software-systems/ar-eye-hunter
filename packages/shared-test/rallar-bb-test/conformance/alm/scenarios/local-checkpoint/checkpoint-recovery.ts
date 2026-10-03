import { AL_CHECKPOINT_DEFAULT_SETTINGS } from '@shared/alm/checkpoint/al-checkpoint-default-settings.ts';

import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import {
    CONNECT_READINESS_TIMEOUT_MS,
    CONNECT_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    RESPONSE_MARGIN_MS,
    STATS_TIMEOUT_MS
} from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toHeldFaultCommands } from '../../alm-conformance-fault-commands.ts';
import {
    toObserveCommand,
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
    RESTORED_SESSION_RALLAR,
    toCheckpointStorePrefix,
    toConnectCommand,
    toOwnerLeaseLapseWait,
    toRecoveryTtlMs,
    toStoreRecoveryWait
} from '../../alm-conformance-session-commands.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import type { AlmReloadCheckpoint } from '../../alm-reload-pair.ts';

const CHECKPOINT_INTERVAL_TOPIC = 'rallar.black-box.alm.checkpoint-interval-elapsed';

/**
 * A `local-checkpoint` send survives its page through the interval checkpoint: the page holds its carrier, admits one
 * original from memory, reads the one checkpoint write the interval made, and reloads. A reload's own `pagehide` flush
 * is best effort and is not what this scenario proves, so the write is read before the page ends. The reloaded page
 * restores the row from the checkpoint store and delivers it once.
 */
export const checkpointRecovery: AlmConformanceScenarioDefinition = {
    scenarioId: 'checkpoint-recovery',
    scenarioKey: 'checkpoint-recovery',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toCheckpointRecoverySenderCommands,
    toRecipientCommands: toCheckpointRecoveryReceiverCommands,
    toReloadCheckpoint
};

function toReloadCheckpoint(step: AlmConformanceStepInput): AlmReloadCheckpoint {
    const sender = { ...step, role: 'sender' as const };
    const receiver = { ...step, role: 'receiver' as const };
    return {
        key: `alm-${step.input.carrier}-${step.scenarioKey}`,
        senderPrefixEnd: toCommandId(sender, 'assert-checkpoint-write'),
        senderReload: toCommandId(sender, 'reload'),
        senderSuffixEnd: toCommandId(sender, 'assert-recovered-claimed'),
        receiverReadyEnd: toCommandId(receiver, 'health-before'),
        receiverAbsenceEnd: toCommandId(receiver, 'absent-before-reload'),
        receiverRecoveryEnd: toCommandId(receiver, 'health-after')
    };
}

function toCheckpointRecoverySenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toHealthCommand(sender, 'health-before'),
        ...toHeldFaultCommands(sender, 'checkpoint-hold', 'until-cleared'),
        toStorageCountersCommand(sender, 'storage-counters-before-send', true),
        toOriginalSend(sender),
        ...toRetainedEvidenceCommands({ ...sender, index: 1 }, true),
        ...toCheckpointWriteCommands(sender),
        {
            kind: 'agent.reload',
            commandId: toCommandId(sender, 'reload'),
            readyTimeoutMs: CONNECT_READINESS_TIMEOUT_MS,
            timeoutMs: CONNECT_TIMEOUT_MS
        },
        ...toRestoredCommands(sender)
    ];
}

/**
 * The send path writes nothing, so after the reset before the send, the first admission write is the interval's one
 * checkpoint readwrite. Nothing emits the topic, so the wait only lets the interval run out.
 */
function toCheckpointWriteCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        {
            kind: 'wait',
            commandId: toCommandId(sender, 'checkpoint-interval-elapses'),
            match: { kind: 'diagnostic', topic: CHECKPOINT_INTERVAL_TOPIC },
            absent: true,
            timeoutMs: AL_CHECKPOINT_DEFAULT_SETTINGS.intervalMs + RESPONSE_MARGIN_MS
        },
        toStorageCountersCommand(sender, 'storage-counters-checkpointed', false),
        toResultAssertion({
            step: sender,
            name: 'assert-checkpoint-write',
            resultName: 'storage-counters-checkpointed',
            field: 'byKind.write',
            operator: 'gt',
            expected: 0
        })
    ];
}

/**
 * The checkpoint holds the row as the hold left it, reserved under a lease, so the reloaded page reconnects once that
 * lease has lapsed and its first batch claims the row.
 */
function toRestoredCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const reconnect = toConnectCommand(sender);
    return [
        toOwnerLeaseLapseWait(sender),
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
        toStoreRecoveryWait(sender, {
            name: 'recovered-checkpoint-store',
            storeIdPrefix: toCheckpointStorePrefix(sender.input.carrier),
            lane: '',
            connectName: 'reconnect',
            timeoutMs: toRecoveryTtlMs(sender.input.deadlineMs)
        }),
        toResultAssertion({
            step: sender,
            name: 'assert-recovered-claimed',
            resultName: 'recovered-checkpoint-store',
            field: 'event.payload.data.outcome.claimed',
            operator: 'gt',
            expected: 0
        })
    ];
}

function toOriginalSend(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return toSendCommand({
        ...sender,
        index: 1,
        payload: toPayload(sender),
        delivery: {
            ack: 'receiver',
            durability: 'local-checkpoint',
            ttlMs: toRecoveryTtlMs(sender.input.deadlineMs),
            commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
        }
    });
}

/** The recovery wait starts beside the sender's reload, so it covers the lease lapse, the reconnect and the drain. */
function toCheckpointRecoveryReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const payload = toPayload(receiver);
    return [
        toHealthCommand(receiver, 'health-before'),
        toPayloadWait({ step: receiver, name: 'absent-before-reload', payload, absent: true }),
        {
            ...toPayloadWait({ step: receiver, name: 'receive-original', payload, absent: false }),
            timeoutMs: toRecoveryTtlMs(receiver.input.deadlineMs)
        },
        toHealthCommand(receiver, 'health-after'),
        toReceivedCommand({ ...receiver, index: 1, count: 2, absent: true })
    ];
}

function toHealthCommand(step: AlmConformanceStepInput, name: string): RallarBlackBoxTestCommand {
    return { kind: 'health', commandId: toCommandId(step, name), timeoutMs: STATS_TIMEOUT_MS };
}

/** The payload names its carrier, so a wait never matches another carrier's cell. */
function toPayload(step: AlmConformanceStepInput): Readonly<Record<string, string>> {
    return { marker: step.scenarioId, carrier: step.input.carrier };
}
