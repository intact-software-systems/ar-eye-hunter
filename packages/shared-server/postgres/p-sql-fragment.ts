import type { PSqlParameter } from './p-sql-sql.ts';

/** The parameters a template part contributes: a fragment's own, or the part itself. */
type PSqlFragmentPartValue<Part> = Part extends PSqlFragment<infer Value> ? Value : Part;

/**
 * One strings array per distinct statement text, for the life of the process. postgres.js keeps an origin error per
 * strings array and never evicts it, so a fresh array per call would grow that cache by the statement text each call;
 * a statement's text is fixed and its parameters vary, so this holds one entry per statement shape.
 */
const STATEMENT_STRINGS_BY_TEXT = new Map<string, TemplateStringsArray>();

/** The same interning for statements planned per execution, so a cached statement of equal text never shares the mark. */
const PLANNED_PER_EXECUTION_STRINGS_BY_TEXT = new Map<string, TemplateStringsArray>();

/** Each statement planned per execution, by its strings array: its text with `$n` positional parameters. */
const PLANNED_PER_EXECUTION_TEXT_BY_STRINGS = new WeakMap<TemplateStringsArray, string>();

/**
 * `cached`: a driver may prepare the statement once per connection, and PostgreSQL then reuses one generic plan.
 * `per-execution`: the statement is planned with its parameters on every execution. A join of a recordset, which the
 * planner always estimates at 100 rows, needs it: a generic plan built while the joined table is small is a hash join
 * over a scan of the whole table, and it is kept, however large the table grows, until the table is analyzed.
 */
type PSqlPlanning = 'cached' | 'per-execution';

/**
 * A piece of SQL text with its own parameters. The `PSqlSql` port accepts only template calls, so a fragment is
 * spliced into a statement's template text, and its parameters stay parameters, before the one call. A fragment is
 * typed by the parameters it carries, so a statement of text-only fragments and one flag carries only that flag.
 */
export class PSqlFragment<Value extends PSqlParameter = PSqlParameter> {
    readonly strings: readonly string[];
    readonly values: readonly Value[];
    private readonly planning: PSqlPlanning;
    /** Set by the first `toStatement`, so a fragment spliced into another never computes it. */
    private statementStrings: TemplateStringsArray | undefined;

    private constructor(strings: readonly string[], values: readonly Value[], planning: PSqlPlanning) {
        this.strings = strings;
        this.values = values;
        this.planning = planning;
    }

    /** A tagged template whose interpolations are parameters, or fragments spliced in place. */
    static of<Parts extends readonly (PSqlParameter | PSqlFragment)[]>(
        strings: TemplateStringsArray,
        ...parts: Parts
    ): PSqlFragment<PSqlFragmentPartValue<Parts[number]>>;
    static of(strings: TemplateStringsArray, ...parts: readonly (PSqlParameter | PSqlFragment)[]): PSqlFragment {
        const texts = [strings[0]];
        const values: PSqlParameter[] = [];
        parts.forEach((part, index) => {
            const following = strings[index + 1];
            if (!(part instanceof PSqlFragment)) {
                values.push(part);
                texts.push(following);
                return;
            }
            texts[texts.length - 1] += part.strings[0];
            texts.push(...part.strings.slice(1));
            values.push(...part.values);
            texts[texts.length - 1] += following;
        });
        return new PSqlFragment(texts, values, 'cached');
    }

    /** A table alias or column name, spliced as text; only a plain lower-case SQL identifier is accepted. */
    static identifier(name: string): PSqlFragment<never> {
        if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
            throw new TypeError(`Not a plain SQL identifier: ${name}`);
        }
        return new PSqlFragment<never>([name], [], 'cached');
    }

    /** The column equal to the one listed text as a scalar parameter, or to any of several as one array parameter. */
    static toTextListPredicate(
        column: PSqlFragment<never>,
        values: readonly string[]
    ): PSqlFragment<string | readonly string[]> {
        const [first, ...rest] = values;
        return first !== undefined && rest.length === 0
            ? PSqlFragment.of`${column} = ${first}`
            : PSqlFragment.of`${column} = any(${values}::text[])`;
    }

    /** The positional text of a statement planned per execution; undefined for a statement whose plan may be cached. */
    static getPlannedPerExecutionText(strings: TemplateStringsArray): string | undefined {
        return PLANNED_PER_EXECUTION_TEXT_BY_STRINGS.get(strings);
    }

    /** This statement, planned with its parameters on every execution instead of by a cached generic plan. */
    toPlannedPerExecution(): PSqlFragment<Value> {
        return new PSqlFragment(this.strings, this.values, 'per-execution');
    }

    /** The template call arguments: `sql(...fragment.toStatement())`; equal text yields the identical strings array. */
    toStatement(): [TemplateStringsArray, ...Value[]] {
        this.statementStrings ??= this.planning === 'cached'
            ? toInternedStatementStrings(this.strings, STATEMENT_STRINGS_BY_TEXT)
            : toPlannedPerExecutionStatementStrings(this.strings);
        return [this.statementStrings, ...this.values];
    }
}

function toPlannedPerExecutionStatementStrings(texts: readonly string[]): TemplateStringsArray {
    const strings = toInternedStatementStrings(texts, PLANNED_PER_EXECUTION_STRINGS_BY_TEXT);
    if (!PLANNED_PER_EXECUTION_TEXT_BY_STRINGS.has(strings)) {
        PLANNED_PER_EXECUTION_TEXT_BY_STRINGS.set(strings, toPositionalText(texts));
    }
    return strings;
}

function toInternedStatementStrings(
    texts: readonly string[],
    stringsByText: Map<string, TemplateStringsArray>
): TemplateStringsArray {
    const textKey = toTextKey(texts);
    const kept = stringsByText.get(textKey);
    if (kept !== undefined) {
        return kept;
    }
    const strings: TemplateStringsArray = Object.freeze(
        Object.assign([...texts], { raw: Object.freeze([...texts]) })
    );
    stringsByText.set(textKey, strings);
    return strings;
}

/** The text a template call sends: each parameter in its place as `$n`, numbered from one. */
function toPositionalText(texts: readonly string[]): string {
    return texts.reduce((text, part, index) => `${text}$${index}${part}`);
}

/** The text's identity: each part prefixed by its length, so no two splits of one text share it. */
function toTextKey(texts: readonly string[]): string {
    return texts.map((text) => `${text.length}:${text}`).join('');
}
