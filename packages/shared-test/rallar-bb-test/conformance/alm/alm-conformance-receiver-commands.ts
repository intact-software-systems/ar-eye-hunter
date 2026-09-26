import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesReceivedCommand,
    RallarBlackBoxTestWaitCommand
} from '../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, RESPONSE_MARGIN_MS } from './alm-conformance-budgets.ts';
import type { AlmConformanceMessageStepInput, AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';
import { toCommandId, toScenarioTypeId } from './alm-conformance-step-identities.ts';

interface AlmConformanceReceivedInput extends AlmConformanceMessageStepInput {
    readonly count: number;
    readonly absent: boolean;
}

interface AlmConformancePayloadWaitInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly payload: Readonly<Record<string, string>>;
    readonly absent: boolean;
}

const INBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.inbound_diagnostics';

/**
 * Positive observation starts before the sender's prologue, so it also owns the complete
 * non-expiring send budget. Absence proof retains the requested evidence deadline.
 */
export function toReceivedCommand(received: AlmConformanceReceivedInput): RallarBlackBoxTestMessagesReceivedCommand {
    const timeoutMs = received.input.deadlineMs + (received.absent ? 0 : NON_EXPIRING_SEND_TIMEOUT_MS);
    return {
        kind: 'messages.received',
        commandId: toCommandId(received, `received-${received.index}`),
        connection: received.input.receiverConnection,
        typeId: toScenarioTypeId(received),
        count: received.count,
        absent: received.absent,
        windowMs: timeoutMs - RESPONSE_MARGIN_MS,
        timeoutMs
    };
}

export function toPayloadWait(
    { step, name, payload, absent }: AlmConformancePayloadWaitInput
): RallarBlackBoxTestCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(step, name),
        match: {
            kind: 'message',
            connection: step.input.receiverConnection,
            payloadPath: 'data.payload',
            equals: payload
        },
        ...(absent ? { absent: true } : {}),
        timeoutMs: step.input.deadlineMs + (absent ? 0 : NON_EXPIRING_SEND_TIMEOUT_MS) - RESPONSE_MARGIN_MS
    };
}

/** The typed receiver subscribes to both transports, so a second delivery of one message counts as two. */
export function toSingleArrivalReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({
            ...receiver,
            index: 1,
            count: 1,
            absent: false
        }),
        toReceivedCommand({
            ...receiver,
            index: 2,
            count: 2,
            absent: true
        })
    ];
}

/**
 * The `admission-outcome` a peer states for a control it received, matched in its emitted key order (`typeId`, then
 * `carrier`, `outcome`, `reason`). The control carries no scenario typeId, so its own typeId scopes the match.
 */
export function toControlAdmissionOutcomeWait(
    step: AlmConformanceStepInput,
    outcome: Readonly<{ name: string; controlTypeId: string; contains: string; timeoutMs: number; }>
): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(step, outcome.name),
        match: {
            kind: 'diagnostic',
            topic: INBOUND_DIAGNOSTICS_TOPIC,
            payloadPath: 'data',
            contains: `"typeId":"${outcome.controlTypeId}",${outcome.contains}`
        },
        timeoutMs: outcome.timeoutMs
    };
}

/**
 * The pair's `admission-outcome` event, matched in its emitted key order (`typeId`, then `carrier`, `outcome`,
 * `reason`); the inbound diagnostics event carries no connection to route on.
 */
export function toAdmissionOutcomeWait(
    step: AlmConformanceStepInput,
    outcome: Readonly<{ name: string; contains: string; timeoutMs: number; }>
): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(step, outcome.name),
        match: {
            kind: 'diagnostic',
            topic: INBOUND_DIAGNOSTICS_TOPIC,
            payloadPath: 'data',
            contains: `"typeId":"${toScenarioTypeId(step)}",${outcome.contains}`
        },
        timeoutMs: outcome.timeoutMs
    };
}
