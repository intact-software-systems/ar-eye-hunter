import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { EXPIRY_TTL_MS, toBudgetMs } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import {
    FAULT_TIMEOUT_MS,
    toFaultCarriers,
    type AlmConformanceFaultCarrier
} from '../alm-conformance-fault-commands.ts';
import {
    toAdmissionCommands,
    toObserveCommand,
    toResultAssertion,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    SMOKE_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toCommandId, toScenarioTypeId } from '../alm-conformance-step-identities.ts';

interface AlmConformanceFaultInput extends AlmConformanceStepInput {
    readonly faultCarrier: AlmConformanceFaultCarrier;
}

const FAULT_REMAINING = 100;

export const deadlineExpiry: AlmConformanceScenarioDefinition = {
    scenarioId: 'deadline-expiry',
    scenarioKey: 'deadline-expiry',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    toSenderCommands: toDeadlineExpirySenderCommands,
    toRecipientCommands: toDeadlineExpiryReceiverCommands
};

function toDeadlineExpiryReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [toReceivedCommand({
        ...receiver,
        index: 1,
        count: 1,
        absent: true
    })];
}

function toDeadlineExpirySenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toFaultCarriers(sender.input.carrier).map((faultCarrier) => toFaultCommand({ ...sender, faultCarrier })),
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: { ttlMs: EXPIRY_TTL_MS, ack: 'receiver' }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({ ...sender, index: 1, state: 'expired' }),
        toResultAssertion({
            step: sender,
            name: 'assert-expired-1',
            resultName: 'observe-expired-1',
            field: 'state',
            operator: 'equals',
            expected: 'expired'
        })
    ];
}

function toFaultCommand(fault: AlmConformanceFaultInput): RallarBlackBoxTestCommand {
    const typeId = toScenarioTypeId(fault);
    return {
        kind: 'fault.inject',
        commandId: toCommandId(fault, `fault-${fault.faultCarrier}`),
        faultId: `drop-${fault.faultCarrier}-${typeId}`,
        carrier: fault.faultCarrier,
        match: { typeId },
        action: 'drop',
        remaining: FAULT_REMAINING,
        timeoutMs: toBudgetMs(FAULT_TIMEOUT_MS, fault.input.deadlineMs)
    };
}
