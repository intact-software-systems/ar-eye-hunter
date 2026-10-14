import type { RallarBlackBoxTestWaitCommand } from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';

/** Nothing emits this topic: the wait that names it only holds its page quiet for its timeout. */
const PAUSE_TOPIC = 'rallar.black-box.alm.pause';

/** A pause of `durationMs` between two commands; the harness has no sleep command, and an absence wait is one. */
export function toPauseCommand(
    step: AlmConformanceStepInput,
    name: string,
    durationMs: number
): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(step, name),
        match: { kind: 'diagnostic', topic: PAUSE_TOPIC },
        absent: true,
        timeoutMs: durationMs
    };
}
