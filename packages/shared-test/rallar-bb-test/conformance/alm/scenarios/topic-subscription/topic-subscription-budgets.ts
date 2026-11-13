import type { RallarBlackBoxTestWaitCommand } from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';

/**
 * One phase of a cell on a loaded lane runner: a grant that waits for its grantee to join, an election, a reconnect
 * and its re-assertion, the readiness of a publication's audience, or a successor page's opening, which waits out
 * the owner's work lease before it connects.
 */
export const SUBSCRIPTION_PHASE_MS = 90_000;

/** How long a role listens, after its positive witness, for a message or event it must not see. */
export const SUBSCRIPTION_ABSENCE_MS = 5_000;

/** One command of a cell: a request, a token change or read, or a send's admission. */
export const SUBSCRIPTION_COMMAND_TIMEOUT_MS = 5_000;

/**
 * Lets a grant, revoke or election's delta reach every member page's snapshot before the next send that must meet it:
 * a sender's own check judges a grant first, and no recipient refuses a copy as `not-yet-in-sync`, whose resend is a
 * repair dispatch of its own.
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
