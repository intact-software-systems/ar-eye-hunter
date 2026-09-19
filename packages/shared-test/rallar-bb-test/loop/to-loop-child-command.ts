import type { RallarBlackBoxTestCommand } from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import { toBoundedDeadlineCommand, toCommandLabelForId } from '../runtime/to-runtime-command-values.ts';

export interface LoopChildContext {
    readonly loopCommandId: string;
    readonly index: number;
    readonly iteration: number;
    readonly elapsedMs: number;
    readonly commandIndex: number;
}

export interface LoopChildCommandInput {
    readonly template: RallarBlackBoxTestCommand;
    readonly context: LoopChildContext;
    /** Absent when neither the loop nor its parent sets a deadline. */
    readonly deadlineEpochMs?: number;
}

type LoopPlaceholderName = 'index' | 'iteration' | 'elapsedMs' | 'commandIndex';

const LOOP_PLACEHOLDER_PATTERN = /\{loop\.(index|iteration|elapsedMs|commandIndex)\}/g;
const LOOP_EXACT_PLACEHOLDER_PATTERN = /^\{loop\.(index|iteration|elapsedMs|commandIndex)\}$/;

export function toLoopChildCommand(input: LoopChildCommandInput): RallarBlackBoxTestCommand {
    const { template, context, deadlineEpochMs } = input;
    const resolved = toLoopPlaceholderValue(template, context) as RallarBlackBoxTestCommand;
    const child = {
        ...resolved,
        commandId: [
            context.loopCommandId,
            `i${context.iteration}`,
            `c${context.commandIndex + 1}`,
            toCommandLabelForId(template, context.commandIndex + 1)
        ].join(':'),
        metadata: {
            ...decodeRecord(resolved.metadata),
            loop: {
                commandId: context.loopCommandId,
                index: context.index,
                iteration: context.iteration,
                elapsedMs: context.elapsedMs,
                commandIndex: context.commandIndex,
                originalCommandId: template.commandId
            }
        }
    } as RallarBlackBoxTestCommand;
    return deadlineEpochMs === undefined ? child : toBoundedDeadlineCommand(child, deadlineEpochMs);
}

function toLoopPlaceholderValue(value: unknown, context: LoopChildContext): unknown {
    if (typeof value === 'string') {
        const exact = LOOP_EXACT_PLACEHOLDER_PATTERN.exec(value);
        return exact
            ? context[exact[1] as LoopPlaceholderName]
            : value.replace(LOOP_PLACEHOLDER_PATTERN, (_match, name: LoopPlaceholderName) => String(context[name]));
    }
    if (Array.isArray(value)) {
        return value.map((entry) => toLoopPlaceholderValue(entry, context));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, toLoopPlaceholderValue(entry, context)])
        );
    }
    return value;
}
