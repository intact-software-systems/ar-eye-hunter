import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toAppliedHeadWaitCommands } from '../cell/to-applied-head-wait-commands.ts';

/**
 * A page's proof that it holds a grant change before its next send: it reads the room's head after an ordering point
 * that follows the change's commit, a cue the writer sent after the change's response or the page's own write, then
 * waits until it applied that head. A page with no such point cannot use it: the head it reads may precede the change.
 */
export function toGrantAppliedHeadCommands(
    step: AlmConformanceStepInput,
    name: string
): readonly RallarBlackBoxTestCommand[] {
    return toAppliedHeadWaitCommands({
        step,
        name,
        purpose: 'Read the room head this page must apply once a grant change committed.',
        historyFrom: 'cell'
    });
}
