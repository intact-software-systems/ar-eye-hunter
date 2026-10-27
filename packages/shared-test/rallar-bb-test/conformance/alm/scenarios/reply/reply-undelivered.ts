import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestTransportFaultInjectCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { EXPIRY_TTL_MS, NON_EXPIRING_SEND_TIMEOUT_MS, toBudgetMs } from '../../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import { FAULT_TIMEOUT_MS } from '../../alm-conformance-fault-commands.ts';
import { toAdmissionCommands, toSendCommand, toVerdictCommands } from '../../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toCommandId, toScenarioTypeId } from '../../alm-conformance-step-identities.ts';
import { toAwaitReplyCommands } from './reply-commands.ts';

const REPLY_UNDELIVERED_CARRIERS: readonly AlmConformanceCarrier[] = ['ws'];

/**
 * D445, the `deadline-expiry.ts` pattern: the transport fault port drops the `command` on its only carrier until its
 * short deadline lapses, and the receiver never receives it. The reply wait arms no deadline timer, so a deadline that
 * lapses during the wait would leave it to its own timeout; the cell first observes the expiry, then reads the reply
 * wait `undelivered` on the `expired` request.
 */
export const replyUndelivered: AlmConformanceScenarioDefinition = {
    scenarioId: 'reply-undelivered',
    scenarioKey: 'reply-undelivered',
    tags: FULL_TAGS,
    carriers: REPLY_UNDELIVERED_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'addressed',
    toSenderCommands: toReplyUndeliveredSenderCommands,
    toRecipientCommands: (receiver) => [toReceivedCommand({ ...receiver, index: 1, count: 1, absent: true })]
};

function toReplyUndeliveredSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toRequestDropFaultCommand(sender, 'fault', 'until-cleared'),
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: { toPeer: 'receiver', ack: 'receiver', ttlMs: EXPIRY_TTL_MS }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        ...toVerdictCommands(sender, 'expired', [['expired', 'state', 'equals', 'expired']]),
        ...toAwaitReplyCommands(
            { ...sender, index: 1 },
            { timeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS, status: 'undelivered', requestState: 'expired' }
        ),
        toRequestDropFaultCommand(sender, 'release', 0)
    ];
}

/** A hold, not a frame count, as in `deadline-expiry`; the same id with `remaining: 0` releases it. */
function toRequestDropFaultCommand(
    sender: AlmConformanceStepInput,
    name: 'fault' | 'release',
    remaining: 'until-cleared' | 0
): RallarBlackBoxTestTransportFaultInjectCommand {
    const typeId = toScenarioTypeId(sender);
    return {
        kind: 'fault.inject',
        commandId: toCommandId(sender, `${name}-ws`),
        faultId: `drop-ws-${typeId}`,
        carrier: 'ws',
        match: { typeId },
        action: 'drop',
        remaining,
        timeoutMs: toBudgetMs(FAULT_TIMEOUT_MS, sender.input.deadlineMs)
    };
}
