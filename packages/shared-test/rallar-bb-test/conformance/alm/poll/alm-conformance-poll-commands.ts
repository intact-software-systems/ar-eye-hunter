import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type { RallarBlackBoxTestAssertComparisonOperator } from '../../../assert/is-assert-comparison.ts';
import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';
import { computeCommandsTimeoutMs } from '../cell/compute-commands-timeout-ms.ts';

const POLL_INTERVAL_MS = 250;

export interface PollCommandInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    /** How long the poll starts attempts; the last one started runs its whole budget past it. */
    readonly phaseMs: number;
    /** One attempt's commands, in order. */
    readonly commands: readonly RallarBlackBoxTestCommand[];
}

/** One read of a poll's attempt, built under the command name it is handed. */
export interface PollRead {
    readonly name: string;
    readonly read: (readName: string) => RallarBlackBoxTestCommand;
}

/** A dot path under the result value of one read of the attempt. */
export interface PollField {
    readonly read: string;
    readonly field: string;
}

/**
 * A field of the attempt held to a literal, held equal to another field of the same attempt, or held equal to (or at or
 * after) a result path a command of the role left before the poll.
 */
export type PollFact =
    | Readonly<{ name: string; source: PollField; operator: ResultFactInput['operator']; expected: ApiJsonValue; }>
    | Readonly<{ name: string; source: PollField; equals: PollField; }>
    | Readonly<{ name: string; source: PollField; operator: ResultComparisonFactInput['operator']; result: string; }>;

export interface ReadPollInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly phaseMs: number;
    /** Each read builds its own timeout; each fact takes this one. */
    readonly commandTimeoutMs: number;
    readonly reads: readonly PollRead[];
    readonly facts: readonly PollFact[];
}

export interface ResultFactInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly source: string;
    readonly operator: 'equals' | 'notEquals' | 'length' | 'exists' | 'matches' | 'matchesShape';
    readonly expected: ApiJsonValue;
    readonly timeoutMs: number;
}

/** `source` equals, or is a number at or after, `comparisonSource`; both are result paths and both must exist. */
interface ResultComparisonFactInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly source: string;
    readonly operator: Exclude<RallarBlackBoxTestAssertComparisonOperator, 'sameUniqueStringSet'>;
    readonly comparisonSource: string;
    readonly timeoutMs: number;
}

/** Child `index` (from 1) of the current attempt of the poll `name`, whose template command is `childId`. */
export interface PollChildInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly index: number;
    readonly childId: string;
}

/**
 * Each attempt runs every child in order and stops at its first failure; the first complete attempt ends the poll. A
 * failed attempt waits `POLL_INTERVAL_MS` before the next, and the loop starts no attempt once `phaseMs` passed (its
 * `durationMs`). Its deadline is the phase plus one attempt's budget, the timeouts of the children that wait (an assert
 * reads results already cached), so the last attempt started inside the phase runs its whole budget. The count caps
 * attempts at those a phase starts when each fails at once, which the phase reaches first.
 */
export function toPollCommand({ step, name, phaseMs, commands }: PollCommandInput): RallarBlackBoxTestCommand {
    const commandId = toCommandId(step, name);
    return {
        kind: 'loop',
        commandId,
        until: 'first-success',
        count: phaseMs / POLL_INTERVAL_MS,
        intervalMs: POLL_INTERVAL_MS,
        durationMs: phaseMs,
        timeoutMs: phaseMs + computeAttemptTimeoutMs(commands, commandId),
        commands
    };
}

function computeAttemptTimeoutMs(commands: readonly RallarBlackBoxTestCommand[], commandId: string): number {
    return computeCommandsTimeoutMs(
        commands.filter(({ kind }) => kind !== 'assert'),
        `the deadline of ${commandId}`
    );
}

/** Repeats the reads, in order, until every fact holds on one attempt's reads. */
export function toReadPollCommand(
    { step, name, phaseMs, commandTimeoutMs, reads, facts }: ReadPollInput
): RallarBlackBoxTestCommand {
    const toReadName = (read: string) => `${name}-${read}`;
    const toSource = ({ read, field }: PollField) => {
        const index = reads.findIndex((candidate) => candidate.name === read) + 1;
        if (index === 0) {
            throw new Error(`The poll ${name} names a fact on ${read}, which it does not read.`);
        }
        return `${toPollResult({ step, name, index, childId: toCommandId(step, toReadName(read)) })}.${field}`;
    };
    return toPollCommand({
        step,
        name,
        phaseMs,
        commands: [
            ...reads.map(({ name: read, read: toRead }) => toRead(toReadName(read))),
            ...facts.map((fact) =>
                'expected' in fact
                    ? toResultFact({ ...fact, step, source: toSource(fact.source), timeoutMs: commandTimeoutMs })
                    : toResultComparisonFact({
                        step,
                        name: fact.name,
                        source: toSource(fact.source),
                        ...('equals' in fact
                            ? { operator: 'equals', comparisonSource: toSource(fact.equals) }
                            : { operator: fact.operator, comparisonSource: fact.result }),
                        timeoutMs: commandTimeoutMs
                    })
            )
        ]
    });
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
        timeoutMs: fact.timeoutMs
    };
}

function toResultComparisonFact(fact: ResultComparisonFactInput): RallarBlackBoxTestCommand {
    return {
        kind: 'assert',
        commandId: toCommandId(fact.step, `assert-${fact.name}`),
        source: fact.source,
        operator: fact.operator,
        comparisonSource: fact.comparisonSource,
        timeoutMs: fact.timeoutMs
    };
}
