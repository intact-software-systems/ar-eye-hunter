import type { PSqlParameter } from '@shared-server/postgres/p-sql-sql.ts';
import { recordRallarTiming, type RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { startRepeating } from '@shared/resilience/start-repeating.ts';
import type { Timers } from '@shared/resilience/timers.ts';

/** The statements of one shape since the previous take. */
export interface PostgresStatementShape {
    readonly shape: string;
    readonly count: number;
    readonly executorWaitMs: number;
    readonly parameterChars: number;
}

export interface PostgresCensusStatement {
    readonly strings: TemplateStringsArray;
    readonly values: readonly PSqlParameter[];
    readonly executorWaitMs: number;
}

interface PostgresStatementShapeTotals {
    count: number;
    executorWaitMs: number;
    parameterChars: number;
}

const SHAPE_LENGTH = 60;

/**
 * Statements by shape: the first 60 characters of the statement text, parameters as `?`, whitespace collapsed. Every SQL shape belongs to
 * one function, so a shape names its caller, and the totals give statements, executor wait and bytes per caller.
 */
export class PostgresStatementCensus {
    private readonly shapeByStrings = new WeakMap<TemplateStringsArray, string>();
    private readonly totalsByShape = new Map<string, PostgresStatementShapeTotals>();

    public record(statement: PostgresCensusStatement): void {
        const shape = this.readShape(statement.strings);
        const totals = this.totalsByShape.get(shape) ?? { count: 0, executorWaitMs: 0, parameterChars: 0 };
        totals.count += 1;
        totals.executorWaitMs += statement.executorWaitMs;
        totals.parameterChars += statement.values.reduce<number>((sum, value) => sum + computeParameterChars(value), 0);
        this.totalsByShape.set(shape, totals);
    }

    /** Every shape recorded since the previous take, the longest total executor wait first; the census starts empty again. */
    public takeShapes(): readonly PostgresStatementShape[] {
        const shapes = [...this.totalsByShape].map(([shape, totals]) => ({ shape, ...totals }));
        this.totalsByShape.clear();
        return shapes.sort((left, right) => right.executorWaitMs - left.executorWaitMs);
    }

    private readShape(strings: TemplateStringsArray): string {
        const kept = this.shapeByStrings.get(strings);
        if (kept !== undefined) {
            return kept;
        }
        const shape = toStatementText(strings).replace(/\s+/gu, ' ').trim().slice(0, SHAPE_LENGTH);
        this.shapeByStrings.set(strings, shape);
        return shape;
    }
}

export interface StartPostgresStatementCensusTimingInput {
    readonly census: PostgresStatementCensus;
    readonly timers: Timers;
    readonly timing: RallarTimingSink;
    readonly serviceId: string;
    readonly intervalMs: number;
}

/** One `postgres statement-census` line per interval that saw a statement; answers the stop. */
export function startPostgresStatementCensusTiming(input: StartPostgresStatementCensusTimingInput): () => void {
    return startRepeating({
        timers: input.timers,
        intervalMs: input.intervalMs,
        firstRun: 'after-interval',
        run: () => {
            const shapes = input.census.takeShapes();
            if (shapes.length === 0) {
                return;
            }
            recordRallarTiming({
                sink: input.timing,
                event: {
                    component: 'postgres',
                    operation: 'statement-census',
                    serviceId: input.serviceId,
                    details: {
                        statements: shapes.reduce((sum, shape) => sum + shape.count, 0),
                        executorWaitMs: Math.round(shapes.reduce((sum, shape) => sum + shape.executorWaitMs, 0)),
                        parameterChars: shapes.reduce((sum, shape) => sum + shape.parameterChars, 0),
                        shapes: JSON.stringify(shapes.map(toRoundedShape))
                    }
                },
                status: 'ok',
                durationMs: input.intervalMs
            });
        }
    });
}

/** Enough of the text, parameters as `?`, to hold a shape after whitespace collapses. */
function toStatementText(strings: TemplateStringsArray): string {
    let text = strings[0]!;
    for (let index = 1; index < strings.length && text.length < SHAPE_LENGTH * 4; index += 1) {
        text += `?${strings[index]}`;
    }
    return text.slice(0, SHAPE_LENGTH * 4);
}

function toRoundedShape(shape: PostgresStatementShape): PostgresStatementShape {
    return { ...shape, executorWaitMs: Math.round(shape.executorWaitMs * 100) / 100 };
}

/** The characters a parameter puts on the wire as text; a structured value counts as its JSON. */
function computeParameterChars(value: PSqlParameter): number {
    if (value === null || value === undefined) {
        return 0;
    }
    if (typeof value === 'string') {
        return value.length;
    }
    if (value instanceof Date) {
        return value.toJSON()?.length ?? 0;
    }
    if (typeof value === 'object') {
        return JSON.stringify(value, (_key, nested) => typeof nested === 'bigint' ? nested.toString() : nested)
            ?.length ?? 0;
    }
    return String(value).length;
}
