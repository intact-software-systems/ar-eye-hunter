import type {
    RallarBlackBoxTestLoopCommand,
    RallarBlackBoxTestMessagesSendCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';

interface AlmFairnessSendLoopInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly count: number;
    readonly send: RallarBlackBoxTestMessagesSendCommand;
}

/**
 * `count` sends of one template, back to back. A loop substitutes `{loop.index}` (0-based) in every string of its
 * template before the send runs, so each send names a handle of its own, and a template may name its ordering key
 * the same way.
 */
export function toSendLoopCommand(
    { step, name, count, send }: AlmFairnessSendLoopInput
): RallarBlackBoxTestLoopCommand {
    return {
        kind: 'loop',
        commandId: toCommandId(step, name),
        count,
        commands: [{ ...send, commandId: toCommandId(step, `${name}-send`), handleId: `${send.handleId}-{loop.index}` }]
    };
}
