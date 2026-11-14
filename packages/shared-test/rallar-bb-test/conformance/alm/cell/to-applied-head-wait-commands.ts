import type {
    RallarBlackBoxTestHttpRequestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../rallar-black-box-test-contracts.ts';

import { CONNECT_READINESS_TIMEOUT_MS } from '../alm-conformance-budgets.ts';
import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';
import { toAlmCellGroupRead } from './to-alm-cell-group-read.ts';
import { toWaitHistoryMetadata, type AlmWaitHistory } from './to-cell-history-marked-commands.ts';
import { toHeldGroupAppliedMatch } from './to-held-group-applied-match.ts';

export const CAUSAL_REVISION_KEYS = ['groupRevision', 'presenceRevision'] as const;

export interface AppliedHeadWaitInput {
    readonly step: AlmConformanceStepInput;
    /** The read is `<name>-read` and the wait `<name>-applied`, so a name is unique within its cell and role. */
    readonly name: string;
    readonly purpose: string;
    /**
     * `page` reads the page's whole history, which the settle's wait needs. In a room per cell no earlier cell left a
     * `held` event of the room. In a room the family shares, a connect writes the page's presence session, but the
     * room's `presenceRevision` advances only when its presence-summary work runs, so the head's floor can equal the
     * revisions of a `held` event an earlier cell left, which matches even when the page's cache dropped the room
     * since: an open window of D647. A `removed` event, which the page emits when its cache drops the group, is not
     * matched. `cell` reads from the cell's own first event on the page, as every other wait of the cell does.
     */
    readonly historyFrom: AlmWaitHistory;
}

/**
 * The page reads the room's head, then waits until it applied that head or a later one: the head read after a write
 * committed is at or past it, so the page holds the write once the wait passes. The read is a request of its own.
 */
export function toAppliedHeadWaitCommands(
    input: AppliedHeadWaitInput
): readonly [RallarBlackBoxTestHttpRequestCommand, RallarBlackBoxTestWaitCommand] {
    const read = toAlmCellGroupRead({
        step: input.step,
        name: `${input.name}-read`,
        resource: 'snapshot',
        purpose: input.purpose
    });
    return [read, toAppliedWait(input, read.commandId!)];
}

function toAppliedWait(input: AppliedHeadWaitInput, readCommandId: string): RallarBlackBoxTestWaitCommand {
    const head = `resultCache.${readCommandId}.value.body.causalRevision`;
    return {
        kind: 'wait',
        commandId: toCommandId(input.step, `${input.name}-applied`),
        match: {
            ...toHeldGroupAppliedMatch(input.step, {}),
            payloadMinimums: Object.fromEntries(
                CAUSAL_REVISION_KEYS.map((key) => [`data.${key}`, `{${head}.${key}}`])
            )
        },
        timeoutMs: CONNECT_READINESS_TIMEOUT_MS,
        ...toWaitHistoryMetadata(input.historyFrom)
    };
}
