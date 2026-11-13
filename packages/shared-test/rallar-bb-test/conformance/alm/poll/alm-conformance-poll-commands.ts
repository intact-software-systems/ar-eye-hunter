import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';

const POLL_INTERVAL_MS = 250;

export interface PollCommandInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    /** How long the poll starts attempts; its last attempt may run one command budget beyond. */
    readonly phaseMs: number;
    /** The caller's budget for one command of an attempt, which the poll's last attempt may also spend. */
    readonly commandTimeoutMs: number;
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

/** A field of the attempt held to a literal, or held equal to another field of the same attempt. */
export type PollFact =
    | Readonly<{ name: string; source: PollField; operator: ResultFactInput['operator']; expected: ApiJsonValue; }>
    | Readonly<{ name: string; source: PollField; equals: PollField; }>;

export interface ReadPollInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly phaseMs: number;
    /** Each read builds its own timeout; each fact and the poll's last attempt take this one. */
    readonly commandTimeoutMs: number;
    readonly reads: readonly PollRead[];
    readonly facts: readonly PollFact[];
}

export interface ResultFactInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly source: string;
    readonly operator: 'equals' | 'notEquals' | 'length' | 'exists' | 'matches';
    readonly expected: ApiJsonValue;
    readonly timeoutMs: number;
}

/** `source` equals `comparisonSource`; both are result paths and both must exist. */
export interface ResultComparisonFactInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly source: string;
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

/** Each attempt runs every child in order and stops at its first failure; the first complete attempt ends the poll. */
export function toPollCommand(
    { step, name, phaseMs, commandTimeoutMs, commands }: PollCommandInput
): RallarBlackBoxTestCommand {
    return {
        kind: 'loop',
        commandId: toCommandId(step, name),
        until: 'first-success',
        count: phaseMs / POLL_INTERVAL_MS,
        intervalMs: POLL_INTERVAL_MS,
        timeoutMs: phaseMs + commandTimeoutMs,
        commands
    };
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
        commandTimeoutMs,
        commands: [
            ...reads.map(({ name: read, read: toRead }) => toRead(toReadName(read))),
            ...facts.map((fact) =>
                'equals' in fact
                    ? toResultComparisonFact({
                        step,
                        name: fact.name,
                        source: toSource(fact.source),
                        comparisonSource: toSource(fact.equals),
                        timeoutMs: commandTimeoutMs
                    })
                    : toResultFact({ ...fact, step, source: toSource(fact.source), timeoutMs: commandTimeoutMs })
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

export function toResultComparisonFact(fact: ResultComparisonFactInput): RallarBlackBoxTestCommand {
    return {
        kind: 'assert',
        commandId: toCommandId(fact.step, `assert-${fact.name}`),
        source: fact.source,
        operator: 'equals',
        comparisonSource: fact.comparisonSource,
        timeoutMs: fact.timeoutMs
    };
}
