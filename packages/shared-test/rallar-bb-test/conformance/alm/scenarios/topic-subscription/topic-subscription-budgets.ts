import type { RallarBlackBoxTestWaitCommand } from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';

/** How long a role listens, after its positive witness, for a message or event it must not see. */
export const SUBSCRIPTION_ABSENCE_MS = 5_000;

/**
 * Lets a sibling's election delta reach every member page's snapshot before the next send that must meet it, where a
 * page that must hold it has no ordering point after the election committed: the receiver, which a copy must find
 * current, waits for no cue and writes nothing after it, so no head read of its own can follow the election. A grant
 * change whose pages all have a point waits for their applied revisions instead (`toGrantAppliedHeadCommands`).
 */
export const GRANT_DELTA_MARGIN_MS = 2_000;

export interface ResultTextInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    /** The command whose result event must, or must not, carry the text. */
    readonly commandId: string;
    readonly topic: 'rallar.bb.messages.subscriptions' | 'rallar.bb.http.response';
    /** May name `{resultCache.<commandId>.<path>}`, so two reads can be compared. */
    readonly text: string;
    readonly absent: boolean;
}

/** Whether an earlier command's result event carries `text`: how a cell compares one read's value with another's. */
export function toResultTextWait(input: ResultTextInput): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(input.step, input.name),
        match: { commandId: input.commandId, topic: input.topic, contains: input.text },
        ...(input.absent ? { absent: true } : {}),
        timeoutMs: 0
    };
}

/** The JSON text a result names a connection generation in; the value may be a result reference. */
export function toGenerationText(connectionGenerationId: string): string {
    return `"connectionGenerationId":"${connectionGenerationId}"`;
}
