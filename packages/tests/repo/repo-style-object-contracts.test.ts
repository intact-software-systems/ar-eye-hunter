import { describe, expect, it } from 'vitest';
import { scanPlainObjectTypeAliases } from '../../../scripts/repo-style-check/contract-rules.mjs';

describe('plain object contract guidance', () => {
    it('reports object aliases in module and namespace scopes', () => {
        const findings = scanPlainObjectTypeAliases(`
            type Account = { readonly id: string };
            export namespace CreateAccount {
                export type Input<T extends ReadonlyArray<string>> = { readonly names: T };
            }
        `);

        expect(findings).toHaveLength(2);
        expect(findings).toEqual(expect.arrayContaining([
            expect.stringContaining('Type alias "Account"'),
            expect.stringContaining('Type alias "Input"')
        ]));
    });

    it('permits mapped types and compositions that require an alias', () => {
        expect(scanPlainObjectTypeAliases(`
            type PolicyNotes = {
                readonly [Aspect in keyof EffectivePolicy]: {
                    readonly effective: EffectivePolicy[Aspect];
                    readonly notes: readonly string[];
                };
            };
            type MutablePolicy<T> = { -readonly [Key in keyof T]-?: T[Key] };
            type RenamedPolicy<T> = { [Key in keyof T as \`next\${Key & string}\`]: T[Key] };
            type State = { readonly kind: 'pending' } | { readonly kind: 'complete' };
            type Scoped = { readonly scope: string } & Account;
            type Pair = [string, number];
            type Decoder = (value: string) => Account;
            type AccountId = string;
        `)).toEqual([]);
    });

    it('still reports a plain object containing a mapped property', () => {
        const findings = scanPlainObjectTypeAliases(`
            type Policy = { readonly values: { [Key in keyof Defaults]: Defaults[Key] } };
            type Values = { readonly [key: string]: number };
        `);

        expect(findings).toHaveLength(2);
        expect(findings).toEqual(expect.arrayContaining([
            expect.stringContaining('Type alias "Policy"'),
            expect.stringContaining('Type alias "Values"')
        ]));
    });

    it('does not treat example strings and comments as declarations', () => {
        expect(scanPlainObjectTypeAliases(`
            /* type Commented = { readonly id: string }; */
            const example = \`
                type Example = { readonly id: string };
            \`;
        `)).toEqual([]);
    });
});
