import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestHttpRequestCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import { toPollChildId, toPollCommand, toResultFact } from '../../poll/alm-conformance-poll-commands.ts';
import { toGroupPath, toSubscriptionRowsCommand, toTokenReadCommand } from './topic-subscription-commands.ts';
import {
    SUBSCRIPTION_COMMAND_TIMEOUT_MS,
    SUBSCRIPTION_PHASE_MS,
    toGenerationText,
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

export interface PresenceGenerationPollInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    /** The token read whose generation the session's room presence must name. */
    readonly tokens: string;
}

/**
 * Re-reads the page's tokens until its socket is open under a generation other than the one `before` read and its one
 * token reads `status`: the reopened socket's re-assertion was answered.
 */
export function toGenerationChangePollCommand(poll: GenerationPollInput): RallarBlackBoxTestCommand {
    const { step, name } = poll;
    const readName = `${name}-read`;
    const attemptRead = toPollChildId({ step, name, index: 1, childId: toCommandId(step, readName) });
    return toPollCommand({
        step,
        name,
        phaseMs: SUBSCRIPTION_PHASE_MS,
        commands: [
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
        ]
    });
}

/** Re-reads the session's rows until it holds one row and that row names, or no longer names, `tokens`' generation. */
export function toRowsGenerationPollCommand(
    { step, name, tokens, names }: RowsGenerationPollInput
): RallarBlackBoxTestCommand {
    const readName = `${name}-read`;
    const attemptRead = toPollChildId({ step, name, index: 1, childId: toCommandId(step, readName) });
    return toPollCommand({
        step,
        name,
        phaseMs: SUBSCRIPTION_PHASE_MS,
        commands: [
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
        ]
    });
}

/**
 * Re-reads the room's snapshot until a presence names `tokens`' generation: the reopened socket re-asserted the
 * session's room presence. A connection generation is the socket's own, so it names the page's session alone.
 */
export function toPresenceGenerationPollCommand(
    { step, name, tokens }: PresenceGenerationPollInput
): RallarBlackBoxTestCommand {
    const readName = `${name}-read`;
    const attemptRead = toPollChildId({ step, name, index: 1, childId: toCommandId(step, readName) });
    return toPollCommand({
        step,
        name,
        phaseMs: SUBSCRIPTION_PHASE_MS,
        commands: [
            toRoomSnapshotCommand(step, readName),
            toResultTextWait({
                step,
                name: `${name}-generation`,
                commandId: attemptRead,
                topic: 'rallar.bb.http.response',
                text: toGenerationText(`{resultCache.${toCommandId(step, tokens)}.value.connectionGenerationId}`),
                absent: false
            })
        ]
    });
}

function toRoomSnapshotCommand(step: AlmConformanceStepInput, name: string): RallarBlackBoxTestHttpRequestCommand {
    return {
        kind: 'http.request',
        commandId: toCommandId(step, name),
        timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
        request: { method: 'GET', path: toGroupPath(step) },
        response: { body: 'json', acceptedStatusCodes: [200] }
    };
}
