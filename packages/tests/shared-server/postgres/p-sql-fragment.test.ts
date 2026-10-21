import { describe, expect, expectTypeOf, it } from 'vitest';

import { PSqlFragment } from '@shared-server/postgres/p-sql-fragment.ts';

describe('SQL fragments', () => {
    it('splice nested fragments into one template call whose parameters stay parameters', () => {
        const row = PSqlFragment.identifier('candidate');
        const predicate = PSqlFragment.of`${row}.ri_status = ${'NEW'} and ${row}.ri_attempts < ${3}`;
        const statement = PSqlFragment.of`select * from resource_inbox candidate where ${predicate} limit ${1}`;

        const [strings, ...values] = statement.toStatement();

        expect([...strings]).toEqual([
            'select * from resource_inbox candidate where candidate.ri_status = ',
            ' and candidate.ri_attempts < ',
            ' limit ',
            ''
        ]);
        expect(strings.raw).toEqual([...strings]);
        expect(Object.hasOwn(strings, 'raw')).toBe(true);
        expect(values).toEqual(['NEW', 3, 1]);
    });

    it('types a statement\'s parameters by the values spliced into it, so a narrower query port accepts it', () => {
        const row = PSqlFragment.identifier('candidate');
        const predicate = PSqlFragment.of`${row}.ri_status is not null`;
        const toStatement = (flag: boolean) => PSqlFragment.of`select * from resource_inbox candidate where ${predicate} and ${flag}`.toStatement();

        expectTypeOf(toStatement).returns.toEqualTypeOf<[TemplateStringsArray, ...boolean[]]>();
        expect(toStatement(true).slice(1)).toEqual([true]);
    });

    it('accepts only a plain identifier as text', () => {
        expect(() => PSqlFragment.identifier('candidate; drop table x')).toThrow(TypeError);
        expect(() => PSqlFragment.identifier('Candidate')).toThrow(TypeError);
    });
});
