import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';

/**
 * One phase of a cell on a loaded lane runner: a grant that waits for its grantee to join, an election, a reconnect
 * and its re-assertion, the readiness of a publication's audience, or a successor page's opening, which waits out
 * the owner's work lease before it connects.
 */
export const SUBSCRIPTION_PHASE_MS = 90_000;

/** One command of a cell: a request, a token change or read, or a send's admission. */
export const SUBSCRIPTION_COMMAND_TIMEOUT_MS = 5_000;

const SUBSCRIPTION_POLL_INTERVAL_MS = 250;

export interface ResultFactInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly source: string;
    readonly operator: 'equals' | 'notEquals' | 'length';
    readonly expected: ApiJsonValue;
}

/** One fact on a field of the current attempt's read; the field is a dot path under the read's result value. */
export interface PollFact extends Pick<ResultFactInput, 'name' | 'operator' | 'expected'> {
    readonly field: string;
}

export interface ReadPollInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    /** Builds the attempt's read under the command name it is handed. */
    readonly read: (readName: string) => RallarBlackBoxTestCommand;
    readonly facts: readonly PollFact[];
}

/** Child `index` (from 1) of the current attempt of the poll `name`, whose template command is `childId`. */
export interface PollChildInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly index: number;
    readonly childId: string;
}

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

/** Each attempt runs every child in order and stops at its first failure; the first complete attempt ends the poll. */
export function toPollCommand(
    step: AlmConformanceStepInput,
    name: string,
    commands: readonly RallarBlackBoxTestCommand[]
): RallarBlackBoxTestCommand {
    return {
        kind: 'loop',
        commandId: toCommandId(step, name),
        until: 'first-success',
        count: SUBSCRIPTION_PHASE_MS / SUBSCRIPTION_POLL_INTERVAL_MS,
        intervalMs: SUBSCRIPTION_POLL_INTERVAL_MS,
        timeoutMs: SUBSCRIPTION_PHASE_MS + SUBSCRIPTION_COMMAND_TIMEOUT_MS,
        commands
    };
}

/** Repeats a read until every fact holds on one attempt's read. */
export function toReadPollCommand({ step, name, read, facts }: ReadPollInput): RallarBlackBoxTestCommand {
    const readName = `${name}-read`;
    const readResult = toPollResult({ step, name, index: 1, childId: toCommandId(step, readName) });
    return toPollCommand(step, name, [
        read(readName),
        ...facts.map(({ field, ...fact }) => toResultFact({ ...fact, step, source: `${readResult}.${field}` }))
    ]);
}

export function toPollChildId({ step, name, index, childId }: PollChildInput): string {
    return `${toCommandId(step, name)}:i{loop.iteration}:c${index}:${childId}`;
}

export function toPollResult(child: PollChildInput): string {
    return `resultCache.${toPollChildId(child)}.value`;
}

export function toResultFact(fact: ResultFactInput): RallarBlackBoxTestCommand {
    return {
        kind: 'assert',
        commandId: toCommandId(fact.step, `assert-${fact.name}`),
        source: fact.source,
        operator: fact.operator,
        expected: fact.expected,
        timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS
    };
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
