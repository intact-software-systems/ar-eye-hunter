import type { PSqlParameter } from './p-sql-sql.ts';

/** The parameters a template part contributes: a fragment's own, or the part itself. */
type PSqlFragmentPartValue<Part> = Part extends PSqlFragment<infer Value> ? Value : Part;

/**
 * One strings array per distinct statement text, for the life of the process. postgres.js keeps an origin error per
 * strings array and never evicts it, so a fresh array per call would grow that cache by the statement text each call;
 * a statement's text is fixed and its parameters vary, so this holds one entry per statement shape.
 */
const STATEMENT_STRINGS_BY_TEXT = new Map<string, TemplateStringsArray>();

/**
 * A piece of SQL text with its own parameters. The `PSqlSql` port accepts only template calls, so a fragment is
 * spliced into a statement's template text, and its parameters stay parameters, before the one call. A fragment is
 * typed by the parameters it carries, so a statement of text-only fragments and one flag carries only that flag.
 */
export class PSqlFragment<Value extends PSqlParameter = PSqlParameter> {
    readonly strings: readonly string[];
    readonly values: readonly Value[];
    /** Set by the first `toStatement`, so a fragment spliced into another never computes it. */
    private statementStrings: TemplateStringsArray | undefined;

    private constructor(strings: readonly string[], values: readonly Value[]) {
        this.strings = strings;
        this.values = values;
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
        return new PSqlFragment(texts, values);
    }

    /** A table alias or column name, spliced as text; only a plain lower-case SQL identifier is accepted. */
    static identifier(name: string): PSqlFragment<never> {
        if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
            throw new TypeError(`Not a plain SQL identifier: ${name}`);
        }
        return new PSqlFragment<never>([name], []);
    }

    /** The template call arguments: `sql(...fragment.toStatement())`; equal text yields the identical strings array. */
    toStatement(): [TemplateStringsArray, ...Value[]] {
        this.statementStrings ??= toInternedStatementStrings(this.strings);
        return [this.statementStrings, ...this.values];
    }
}

function toInternedStatementStrings(texts: readonly string[]): TemplateStringsArray {
    const textKey = toTextKey(texts);
    const kept = STATEMENT_STRINGS_BY_TEXT.get(textKey);
    if (kept !== undefined) {
        return kept;
    }
    const strings: TemplateStringsArray = Object.freeze(
        Object.assign([...texts], { raw: Object.freeze([...texts]) })
    );
    STATEMENT_STRINGS_BY_TEXT.set(textKey, strings);
    return strings;
}

/** The text's identity: each part prefixed by its length, so no two splits of one text share it. */
function toTextKey(texts: readonly string[]): string {
    return texts.map((text) => `${text.length}:${text}`).join('');
}
