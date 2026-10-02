import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, toBudgetMs } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import { toAdmissionQuotaFaultId, toStorageQuotaFaultCommands } from '../alm-conformance-fault-commands.ts';
import {
    toAdmissionCommands,
    toObserveCommand,
    toResultAssertion,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toPayloadWait } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceMessageStepInput,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';

const STORAGE_TOPIC = 'rallar.browser.alm.storage';

/**
 * A full disk under a durable channel: while every admission write fails with a quota error, the channel that refuses
 * fails its send typed and the channel that goes volatile delivers it without storage, saying so; once the quota
 * frees, the next durable send commits and the store reads healthy again. One type id carries both channels: the
 * channel's choice is its own, not the type's. The work-queue writes are held too: a work release that commits records
 * a recovery point, which would read the store healthy during the hold, so only the third send's admission can.
 */
export const storageUnavailable: AlmConformanceScenarioDefinition = {
    scenarioId: 'storage-unavailable',
    scenarioKey: 'storage-unavailable',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toStorageUnavailableSenderCommands,
    toRecipientCommands: toStorageUnavailableReceiverCommands
};

function toStorageUnavailableSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toStorageQuotaFaultCommands(sender, 'hold'),
        ...toRefusedSendCommands({ ...sender, index: 1 }),
        toQuotaHealthWait(sender, 'health-failing', 'failing'),
        ...toDowngradedSendCommands({ ...sender, index: 2 }),
        ...toStorageQuotaFaultCommands(sender, 'release'),
        ...toDurableSendCommands({ ...sender, index: 3 }),
        toQuotaHealthWait(sender, 'health-healthy', 'healthy')
    ];
}

/** The default channel refuses: the handle fails with the storage cause and nothing is sent. */
function toRefusedSendCommands(send: AlmConformanceMessageStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({ ...send, payload: toPayload(send), delivery: { durability: 'local-outbox' } }),
        toObserveCommand({ ...send, state: 'failed' }),
        ...([['failure.kind', 'storage-unavailable'], ['failure.cause', 'quota'], ['submitted', false]] as const).map((
            [field, expected]
        ) => toResultAssertion({
            step: send,
            name: `assert-refused-${field.replace('.', '-')}-${send.index}`,
            resultName: `observe-failed-${send.index}`,
            field,
            operator: 'equals',
            expected
        }))
    ];
}

/** The volatile channel admits the same message on the memory pair once and names the durability it lost. */
function toDowngradedSendCommands(send: AlmConformanceMessageStepInput): readonly RallarBlackBoxTestCommand[] {
    const facts = [
        ['enqueued', false],
        ['durabilityDowngrade.requested', 'local-outbox'],
        ['durabilityDowngrade.cause', 'quota']
    ] as const;
    return [
        toSendCommand({
            ...send,
            payload: toPayload(send),
            delivery: { durability: 'local-outbox', onStorageUnavailable: 'volatile' }
        }),
        ...toAdmissionCommands(send),
        ...facts.map(([field, expected]) =>
            toResultAssertion({
                step: send,
                name: `assert-downgraded-${field.replace('.', '-')}-${send.index}`,
                resultName: `observe-admitted-${send.index}`,
                field,
                operator: 'equals',
                expected
            })
        )
    ];
}

function toDurableSendCommands(send: AlmConformanceMessageStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({ ...send, payload: toPayload(send), delivery: { durability: 'local-outbox' } }),
        ...toAdmissionCommands(send),
        toResultAssertion({
            step: send,
            name: `assert-enqueued-${send.index}`,
            resultName: `observe-admitted-${send.index}`,
            field: 'enqueued',
            operator: 'equals',
            expected: true
        })
    ];
}

/** The downgraded and the recovered sends arrive; the refused one never does. */
function toStorageUnavailableReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toPayloadWait({
            step: receiver,
            name: 'receive-2',
            payload: toPayload({ ...receiver, index: 2 }),
            absent: false
        }),
        {
            ...toPayloadWait({
                step: receiver,
                name: 'receive-3',
                payload: toPayload({ ...receiver, index: 3 }),
                absent: false
            }),
            timeoutMs: receiver.input.deadlineMs + 2 * NON_EXPIRING_SEND_TIMEOUT_MS
        },
        toPayloadWait({ step: receiver, name: 'absent-1', payload: toPayload({ ...receiver, index: 1 }), absent: true })
    ];
}

/** One receiver page hears every carrier's cell, so the payload names the carrier. */
function toPayload(step: AlmConformanceMessageStepInput): Readonly<Record<string, string>> {
    return { marker: step.scenarioId, carrier: step.input.carrier, send: String(step.index) };
}

/**
 * A durable store's `health` transition on the storage port, matched in its emitted key order (`status`, then
 * `lastFailure` with `cause` and `detail`). The scripted fault names its id in the detail, and the id carries the
 * cell's type id, so neither match can be a transition of an earlier cell. The failure stays the last one once the
 * store reads `healthy` again, so the healthy match cannot be an earlier healthy reading either.
 */
function toQuotaHealthWait(
    step: AlmConformanceStepInput,
    name: string,
    status: 'failing' | 'healthy'
): RallarBlackBoxTestCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(step, name),
        match: {
            kind: 'diagnostic',
            topic: STORAGE_TOPIC,
            payloadPath: 'data',
            contains: `"status":"${status}","lastFailure":{"cause":"quota",` +
                `"detail":"QuotaExceededError: Scripted storage quota fault ${toAdmissionQuotaFaultId(step)}"`
        },
        timeoutMs: toBudgetMs(NON_EXPIRING_SEND_TIMEOUT_MS, step.input.deadlineMs)
    };
}
