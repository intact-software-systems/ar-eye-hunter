import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import { toSubscriptionRowsCommand, toTokenReadCommand } from './topic-subscription-commands.ts';
import {
    toGenerationText,
    toPollChildId,
    toPollCommand,
    toResultFact,
    toResultTextWait
} from './topic-subscription-polls.ts';

export interface GenerationPollInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    /** The token read before the socket dropped, whose generation the open socket must no longer name. */
    readonly before: string;
    readonly status: 'active' | 'refused';
}

export interface RowsGenerationPollInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    /** The token read whose generation the session's one row must name, or must no longer name. */
    readonly tokens: string;
    readonly names: boolean;
}

/**
 * Re-reads the page's tokens until its socket is open under a generation other than the one `before` read and its one
 * token reads `status`: the reopened socket's re-assertion was answered.
 */
export function toGenerationChangePollCommand(poll: GenerationPollInput): RallarBlackBoxTestCommand {
    const { step, name } = poll;
    const readName = `${name}-read`;
    const attemptRead = toPollChildId({ step, name, index: 1, childId: toCommandId(step, readName) });
    return toPollCommand(step, name, [
        toTokenReadCommand(step, readName),
        toResultFact({
            step,
            name: `${name}-open`,
            source: `resultCache.${attemptRead}.value.connectionGenerationId`,
            operator: 'notEquals',
            expected: null
        }),
        toResultFact({
            step,
            name: `${name}-${poll.status}`,
            source: `resultCache.${attemptRead}.value.subscriptions.0.status`,
            operator: 'equals',
            expected: poll.status
        }),
        toResultTextWait({
            step,
            name: `${name}-changed`,
            commandId: attemptRead,
            topic: 'rallar.bb.messages.subscriptions',
            text: toGenerationText(`{resultCache.${toCommandId(step, poll.before)}.value.connectionGenerationId}`),
            absent: true
        })
    ]);
}

/** Re-reads the session's rows until it holds one row and that row names, or no longer names, `tokens`' generation. */
export function toRowsGenerationPollCommand(
    { step, name, tokens, names }: RowsGenerationPollInput
): RallarBlackBoxTestCommand {
    const readName = `${name}-read`;
    const attemptRead = toPollChildId({ step, name, index: 1, childId: toCommandId(step, readName) });
    return toPollCommand(step, name, [
        toSubscriptionRowsCommand(step, readName),
        toResultFact({
            step,
            name: `${name}-one-row`,
            source: `resultCache.${attemptRead}.value.body.subscriptions`,
            operator: 'length',
            expected: 1
        }),
        toResultTextWait({
            step,
            name: `${name}-generation`,
            commandId: attemptRead,
            topic: 'rallar.bb.http.response',
            text: toGenerationText(`{resultCache.${toCommandId(step, tokens)}.value.connectionGenerationId}`),
            absent: !names
        })
    ]);
}
