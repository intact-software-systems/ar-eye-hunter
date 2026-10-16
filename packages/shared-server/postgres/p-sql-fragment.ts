import type { PSqlParameter } from './p-sql-sql.ts';

/**
 * A piece of SQL text with its own parameters. The `PSqlSql` port accepts only template calls, so a fragment is
 * spliced into a statement's template text, and its parameters stay parameters, before the one call.
 */
export class PSqlFragment {
    readonly strings: readonly string[];
    readonly values: readonly PSqlParameter[];

    private constructor(strings: readonly string[], values: readonly PSqlParameter[]) {
        this.strings = strings;
        this.values = values;
    }

    /** A tagged template whose interpolations are parameters, or fragments spliced in place. */
    static of(
        strings: TemplateStringsArray,
        ...parts: readonly (PSqlParameter | PSqlFragment)[]
    ): PSqlFragment {
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
    static identifier(name: string): PSqlFragment {
        if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
            throw new TypeError(`Not a plain SQL identifier: ${name}`);
        }
        return new PSqlFragment([name], []);
    }

    /** The template call arguments: `sql(...fragment.toStatement())`. */
    toStatement(): [TemplateStringsArray, ...PSqlParameter[]] {
        const strings: TemplateStringsArray = Object.assign([...this.strings], { raw: [...this.strings] });
        return [strings, ...this.values];
    }
}
