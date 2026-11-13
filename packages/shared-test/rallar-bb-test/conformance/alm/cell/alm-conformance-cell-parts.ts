import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { toStorageCountersCommand } from '../alm-conformance-message-commands.ts';
import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import {
    toConnectCommand,
    toEnsureGroupCommand,
    toSelfMembershipCommand,
    toStatsCommand
} from '../alm-conformance-session-commands.ts';
import { toCommandId, toConnectionName } from '../alm-conformance-step-identities.ts';
import { toOwnerLeaseLapseWait } from '../to-pause-command.ts';
import { toCellHistoryMarkedCommands } from './to-cell-history-marked-commands.ts';

/**
 * A role's recipe in two parts. The prologue opens the role's page, through the connect. The body is the cell itself,
 * opened by the sender's own storage baseline, and every wait in it reads its own cell's history. A combined recipe
 * shares one prologue and runs each cell's body.
 */
export interface AlmConformanceCellParts {
    readonly prologue: readonly RallarBlackBoxTestCommand[];
    readonly body: readonly RallarBlackBoxTestCommand[];
}

export interface AlmConformanceCellPartsInput extends AlmConformanceStepInput {
    /** The definition's own commands for the role. */
    readonly commands: readonly RallarBlackBoxTestCommand[];
    readonly almDiagnostics: boolean;
    readonly deliveryDiagnostics: boolean;
}

const ALM_DIAGNOSTIC_TOPICS = [
    'rallar.browser.alm.outbound_diagnostics',
    'rallar.browser.alm.inbound_diagnostics',
    'rallar.browser.alm.storage',
    'rallar.browser.alm.storage_reset'
];

export function toAlmConformanceCellParts(input: AlmConformanceCellPartsInput): AlmConformanceCellParts {
    const connect = toConnectCommand(input);
    return {
        prologue: [
            ...(input.deliveryDiagnostics ? toFreshDiagnosticHistoryCommands(input) : []),
            toEnsureGroupCommand(input),
            toSelfMembershipCommand(input, 'active'),
            ...(input.role === 'successor' ? [toOwnerLeaseLapseWait(input)] : []),
            { ...connect, rallar: { ...connect.rallar, almDiagnostics: input.almDiagnostics } },
            ...(input.deliveryDiagnostics ? [toAppliedDiagnosticsWait(input)] : [])
        ],
        body: toCellHistoryMarkedCommands(input, [
            ...toConnectedStorageCountersCommands(input),
            ...input.commands,
            toStatsCommand(input, 'stats'),
            ...(input.deliveryDiagnostics ? toDeliveryDiagnosticEvidenceCommands(input) : [])
        ])
    };
}

/**
 * Pre-send evidence. A sender whose send exhausts its budget stops the recipe before the
 * post-receipts counters run, so this reading is the only IndexedDB operation count a timed-out
 * scenario leaves behind, and the pair brackets the operations one typed send spends.
 */
function toConnectedStorageCountersCommands(
    step: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return step.role === 'sender' ? [toStorageCountersCommand(step, 'storage-counters-connected', false)] : [];
}

/** The page is fresh: none of these has been emitted on it yet, so these read the page's whole history. */
function toFreshDiagnosticHistoryCommands(step: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [...ALM_DIAGNOSTIC_TOPICS, 'rallar.browser.connect.phase_completed'].map((topic) => ({
        kind: 'wait',
        commandId: toCommandId(step, `fresh-${topic.split('.').at(-1)}`),
        match: { kind: 'diagnostic', topic },
        absent: true,
        timeoutMs: 0
    }));
}

function toAppliedDiagnosticsWait(input: AlmConformanceCellPartsInput): RallarBlackBoxTestCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(input, 'applied-diagnostics'),
        match: {
            kind: 'diagnostic',
            connection: toConnectionName(input),
            topic: 'rallar.browser.connect.phase_completed',
            payloadFields: { 'data.phase': 'rallar-connect', 'data.almDiagnostics': input.almDiagnostics }
        },
        timeoutMs: 0
    };
}

function toDeliveryDiagnosticEvidenceCommands(
    input: AlmConformanceCellPartsInput
): readonly RallarBlackBoxTestCommand[] {
    const topics = input.almDiagnostics
        ? [
            input.role === 'sender'
                ? 'rallar.browser.alm.outbound_diagnostics'
                : 'rallar.browser.alm.inbound_diagnostics'
        ]
        : ALM_DIAGNOSTIC_TOPICS;
    return topics.map((topic) => ({
        kind: 'wait',
        commandId: toCommandId(input, `diagnostic-${topic.split('.').at(-1)}`),
        match: { kind: 'diagnostic', topic },
        ...(input.almDiagnostics ? {} : { absent: true }),
        // Delivery and the receiver's authored negative-control window bound this already retained interval.
        timeoutMs: 0
    }));
}
