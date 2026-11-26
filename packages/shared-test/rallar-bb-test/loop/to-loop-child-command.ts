import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestJsonValue,
    RallarBlackBoxTestRecord
} from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import { toBoundedDeadlineCommand, toCommandLabelForId } from '../runtime/to-runtime-command-values.ts';

export interface LoopChildContext {
    readonly loopCommandId: string;
    readonly index: number;
    readonly iteration: number;
    readonly elapsedMs: number;
    /** The runtime clock when the child was resolved; `elapsedMs` is derived from this same read. */
    readonly atEpochMs: number;
    readonly commandIndex: number;
}

export interface LoopChildCommandInput {
    readonly template: RallarBlackBoxTestCommand;
    readonly context: LoopChildContext;
    /** Absent when neither the loop nor its parent sets a deadline. */
    readonly deadlineEpochMs?: number;
}

const LOOP_PLACEHOLDER_NAMES = ['index', 'iteration', 'elapsedMs', 'atEpochMs', 'commandIndex'] as const;

type LoopPlaceholderName = (typeof LOOP_PLACEHOLDER_NAMES)[number];

const LOOP_PLACEHOLDER_PATTERN_SOURCE = `\\{loop\\.(${LOOP_PLACEHOLDER_NAMES.join('|')})\\}`;
const LOOP_PLACEHOLDER_PATTERN = new RegExp(LOOP_PLACEHOLDER_PATTERN_SOURCE, 'g');
const LOOP_EXACT_PLACEHOLDER_PATTERN = new RegExp(`^${LOOP_PLACEHOLDER_PATTERN_SOURCE}$`);

export function toLoopChildCommand(input: LoopChildCommandInput): RallarBlackBoxTestCommand {
    const { template, context, deadlineEpochMs } = input;
    const resolved = toLoopResolvedMembers(template, context) as RallarBlackBoxTestCommand;
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

/**
 * The members of a command or of a record it carries, each with its loop placeholders resolved at any depth. A member
 * with no JSON form, such as an optional one a recipe built in process writes as `undefined`, stays as it is.
 */
function toLoopResolvedMembers(
    holder: RallarBlackBoxTestCommand | RallarBlackBoxTestRecord,
    context: LoopChildContext
): RallarBlackBoxTestRecord {
    return Object.fromEntries(
        Object.entries(holder).map(([key, member]) => [
            key,
            isCommandJsonValue(member) ? toLoopResolvedJsonValue(member, context) : member
        ])
    );
}

/** Text that is one placeholder alone becomes that number; a placeholder inside longer text becomes its digits. */
function toLoopResolvedJsonValue(
    value: RallarBlackBoxTestJsonValue,
    context: LoopChildContext
): RallarBlackBoxTestJsonValue {
    if (typeof value === 'string') {
        const exact = LOOP_EXACT_PLACEHOLDER_PATTERN.exec(value);
        return exact
            ? context[exact[1] as LoopPlaceholderName]
            : value.replace(LOOP_PLACEHOLDER_PATTERN, (_match, name: LoopPlaceholderName) => String(context[name]));
    }
    if (isCommandJsonList(value)) {
        return value.map((entry) => toLoopResolvedJsonValue(entry, context));
    }
    return value !== null && typeof value === 'object' ? toLoopResolvedMembers(value, context) : value;
}

/** Reads only the value itself; a list entry or a record member is read when the walk reaches it. */
function isCommandJsonValue(value: unknown): value is RallarBlackBoxTestJsonValue {
    return value === null || typeof value === 'object' || typeof value === 'string' || typeof value === 'number' ||
        typeof value === 'boolean';
}

function isCommandJsonList(value: RallarBlackBoxTestJsonValue): value is readonly RallarBlackBoxTestJsonValue[] {
    return Array.isArray(value);
}
