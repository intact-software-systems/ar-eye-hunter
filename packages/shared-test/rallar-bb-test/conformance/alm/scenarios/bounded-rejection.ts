import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { ASSERT_TIMEOUT_MS, toBudgetMs } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import {
    toCancelCommand,
    toObserveCommand,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    SMOKE_TAGS,
    type AlmConformanceMessageStepInput,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';

interface AlmConformanceAssertInput extends AlmConformanceMessageStepInput {
    readonly field: 'status' | 'reason';
    readonly operator: 'equals' | 'contains';
    readonly expected: string;
}

const OVERSIZED_PAYLOAD_BYTES = 70_000;
const OVERSIZED_PAYLOAD_FILLER = 'x'.repeat(OVERSIZED_PAYLOAD_BYTES);
const OVERSIZED_REJECTION_REASON = 'Payload exceeds';

export const boundedRejection: AlmConformanceScenarioDefinition = {
    scenarioId: 'bounded-rejection',
    scenarioKey: 'bounded-rejection',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    toSenderCommands: toBoundedRejectionSenderCommands,
    toReceiverCommands: toBoundedRejectionReceiverCommands
};

function toBoundedRejectionReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [toReceivedCommand({
        ...receiver,
        index: 1,
        count: 1,
        absent: true
    })];
}

function toBoundedRejectionSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, filler: OVERSIZED_PAYLOAD_FILLER },
            delivery: {}
        }),
        toSendAssertCommand({
            ...sender,
            index: 1,
            field: 'status',
            operator: 'equals',
            expected: 'rejected'
        }),
        toSendAssertCommand({
            ...sender,
            index: 1,
            field: 'reason',
            operator: 'contains',
            expected: OVERSIZED_REJECTION_REASON
        }),
        toObserveCommand({ ...sender, index: 1, state: 'rejected' }),
        toCancelCommand({ ...sender, index: 1 }),
        {
            ...toObserveCommand({ ...sender, index: 1, state: 'rejected' }),
            commandId: toCommandId(sender, 'observe-rejected-after-cancel-1')
        }
    ];
}

function toSendAssertCommand(assertion: AlmConformanceAssertInput): RallarBlackBoxTestCommand {
    const sendCommandId = toCommandId(assertion, `send-${assertion.index}`);
    return {
        kind: 'assert',
        commandId: toCommandId(assertion, `assert-${assertion.field}-${assertion.index}`),
        source: `resultCache.${sendCommandId}.value.${assertion.field}`,
        operator: assertion.operator,
        expected: assertion.expected,
        timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, assertion.input.deadlineMs)
    };
}
