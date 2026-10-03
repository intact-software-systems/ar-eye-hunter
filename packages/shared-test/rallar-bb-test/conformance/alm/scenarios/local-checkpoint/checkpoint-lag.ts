import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, toBudgetMs } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toStorageQuotaFaultCommands } from '../../alm-conformance-fault-commands.ts';
import { toAdmissionCommands, toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toPayloadWait } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceMessageStepInput,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { RECOVERED_STORE_PREFIXES } from '../../alm-conformance-session-commands.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import { toStorageRefusedSendCommands, toStorageScenarioPayload } from '../storage-unavailable.ts';

const STORAGE_TOPIC = 'rallar.browser.alm.storage';

/**
 * The browser store factory's default recovery-lag bound, which this Deno-loaded catalog cannot import: a checkpoint
 * store whose oldest unsaved change is older fails with `checkpoint-lag`.
 */
export const CHECKPOINT_LAG_BOUND_MS = 10_000;

type CheckpointHealthStatus = 'delayed' | 'failing' | 'healthy';

/**
 * A full disk under a `local-checkpoint` channel: the send path stores nothing, so the first send is admitted while
 * every admission and work-queue write fails; its checkpoint cannot be written, so the lane's store reads `delayed`,
 * then `failing` with `checkpoint-lag`, and the refusing channel fails the next send typed. Once the quota frees, the
 * next checkpoint writes, the store reads `healthy` again and a send is admitted.
 */
export const checkpointLag: AlmConformanceScenarioDefinition = {
    scenarioId: 'checkpoint-lag',
    scenarioKey: 'checkpoint-lag',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toCheckpointLagSenderCommands,
    toRecipientCommands: toCheckpointLagReceiverCommands
};

function toCheckpointLagSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toStorageQuotaFaultCommands(sender, 'hold'),
        ...toAdmittedSendCommands({ ...sender, index: 1 }),
        toCheckpointHealthWait(sender, 'delayed'),
        toCheckpointHealthWait(sender, 'failing'),
        ...toStorageRefusedSendCommands({ ...sender, index: 2 }, {
            durability: 'local-checkpoint',
            cause: 'checkpoint-lag'
        }),
        ...toStorageQuotaFaultCommands(sender, 'release'),
        toCheckpointHealthWait(sender, 'healthy'),
        ...toAdmittedSendCommands({ ...sender, index: 3 })
    ];
}

function toAdmittedSendCommands(send: AlmConformanceMessageStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...send,
            payload: toStorageScenarioPayload(send),
            delivery: { durability: 'local-checkpoint' }
        }),
        ...toAdmissionCommands(send)
    ];
}

/**
 * The checkpoint store of the lane that admitted the sends, matched in its emitted key order (`kind`, `storeId`, then
 * the state's `status` and `lastFailure`). Without a hold the fallback carrier keeps its sends in the overlay. The
 * store id embeds the session of the cell's own connect, so no other cell's store can match.
 */
function toCheckpointHealthWait(
    step: AlmConformanceStepInput,
    status: CheckpointHealthStatus
): RallarBlackBoxTestCommand {
    const prefix = step.input.carrier === 'ws'
        ? RECOVERED_STORE_PREFIXES.wsCheckpoint
        : RECOVERED_STORE_PREFIXES.rtcCheckpoint;
    const storeId = `${prefix}:{resultCache.${toCommandId(step, 'connect')}.value.sessionId}`;
    const failure = status === 'failing' ? ',"lastFailure":{"cause":"checkpoint-lag"' : '';
    return {
        kind: 'wait',
        commandId: toCommandId(step, `health-${status}`),
        match: {
            kind: 'diagnostic',
            topic: STORAGE_TOPIC,
            payloadPath: 'data',
            contains: `"kind":"health","storeId":"${storeId}","status":"${status}"${failure}`
        },
        timeoutMs: status === 'failing'
            ? CHECKPOINT_LAG_BOUND_MS + NON_EXPIRING_SEND_TIMEOUT_MS
            : toBudgetMs(NON_EXPIRING_SEND_TIMEOUT_MS, step.input.deadlineMs)
    };
}

/** The admitted sends arrive and the refused one never does; the third waits out the lag and its recovery. */
function toCheckpointLagReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const toWait = (index: number, absent: boolean) =>
        toPayloadWait({
            step: receiver,
            name: absent ? `absent-${index}` : `receive-${index}`,
            payload: toStorageScenarioPayload({ ...receiver, index }),
            absent
        });
    return [
        toWait(1, false),
        {
            ...toWait(3, false),
            timeoutMs: receiver.input.deadlineMs + CHECKPOINT_LAG_BOUND_MS + 2 * NON_EXPIRING_SEND_TIMEOUT_MS
        },
        toWait(2, true)
    ];
}
