import type {
    RallarBlackBoxTestLoopCommand,
    RallarBlackBoxTestMessagesSendCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';

/**
 * The pause after each send of a loop, which awaits the send before it pauses: at most about 13 sends a second, under
 * the RTC lane's 20 a second limiter, which the receiver's own ACKs and control frames share.
 */
export const FAIRNESS_SEND_INTERVAL_MS = 75;

interface AlmFairnessSendLoopInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly count: number;
    readonly send: RallarBlackBoxTestMessagesSendCommand;
    /** The longest the whole loop may take; each send's own timeout bounds its iteration. */
    readonly timeoutMs: number;
}

/**
 * `count` sends of one template, each awaited and then followed by a pause of `FAIRNESS_SEND_INTERVAL_MS`, within
 * `timeoutMs`. A loop substitutes `{loop.index}` (0-based) in every string of its template before the send runs, so
 * each send names a handle of its own, and a template may name its ordering key the same way.
 */
export function toSendLoopCommand(
    { step, name, count, send, timeoutMs }: AlmFairnessSendLoopInput
): RallarBlackBoxTestLoopCommand {
    return {
        kind: 'loop',
        commandId: toCommandId(step, name),
        count,
        intervalMs: FAIRNESS_SEND_INTERVAL_MS,
        timeoutMs,
        commands: [{ ...send, commandId: toCommandId(step, `${name}-send`), handleId: `${send.handleId}-{loop.index}` }]
    };
}
