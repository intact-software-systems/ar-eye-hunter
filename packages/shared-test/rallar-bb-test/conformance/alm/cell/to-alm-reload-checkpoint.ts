import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRtcConnectCommand
} from '../../../rallar-black-box-test-contracts.ts';

import { CONNECT_READINESS_TIMEOUT_MS, CONNECT_TIMEOUT_MS, STATS_TIMEOUT_MS } from '../alm-conformance-budgets.ts';
import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { RESTORED_SESSION_RALLAR, toConnectCommand } from '../alm-conformance-session-commands.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';
import type { AlmReloadCheckpoint } from '../alm-reload-pair.ts';
import { toAlmCellCommandPrefix } from './to-alm-cell-command-prefix.ts';

/** The names of the commands a reload cell's phases end on; the sender's reload is {@link toReloadCommand}'s. */
export interface AlmReloadPhaseEnds {
    readonly senderPrefixEnd: string;
    readonly senderSuffixEnd: string;
    readonly receiverReadyEnd: string;
    readonly receiverAbsenceEnd: string;
    readonly receiverRecoveryEnd: string;
}

/** The cell's one reload checkpoint, keyed by the cell, with each phase end named as the role's own command. */
export function toAlmReloadCheckpoint(step: AlmConformanceStepInput, ends: AlmReloadPhaseEnds): AlmReloadCheckpoint {
    const sender = { ...step, role: 'sender' as const };
    const receiver = { ...step, role: 'receiver' as const };
    return {
        key: toAlmCellCommandPrefix(step.input.carrier, step.scenarioKey),
        senderPrefixEnd: toCommandId(sender, ends.senderPrefixEnd),
        senderReload: toCommandId(sender, 'reload'),
        senderSuffixEnd: toCommandId(sender, ends.senderSuffixEnd),
        receiverReadyEnd: toCommandId(receiver, ends.receiverReadyEnd),
        receiverAbsenceEnd: toCommandId(receiver, ends.receiverAbsenceEnd),
        receiverRecoveryEnd: toCommandId(receiver, ends.receiverRecoveryEnd)
    };
}

/** The sender's one reload of a reload pair: the agent replaces the page's document and reports ready again. */
export function toReloadCommand(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'agent.reload',
        commandId: toCommandId(sender, 'reload'),
        readyTimeoutMs: CONNECT_READINESS_TIMEOUT_MS,
        timeoutMs: CONNECT_TIMEOUT_MS
    };
}

/** The reloaded document's first connect, which keeps the auth session the old document held. */
export function toRestoredReconnectCommand(sender: AlmConformanceStepInput): RallarBlackBoxTestRtcConnectCommand {
    const reconnect = toConnectCommand(sender);
    return {
        ...reconnect,
        commandId: toCommandId(sender, 'reconnect'),
        rallar: { ...reconnect.rallar, ...RESTORED_SESSION_RALLAR }
    };
}

/** A health read: a phase of a reload pair ends on one where no assertion of its own marks the end. */
export function toReloadPhaseHealthCommand(step: AlmConformanceStepInput, name: string): RallarBlackBoxTestCommand {
    return { kind: 'health', commandId: toCommandId(step, name), timeoutMs: STATS_TIMEOUT_MS };
}
