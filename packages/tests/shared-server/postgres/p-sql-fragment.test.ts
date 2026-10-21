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

    it('hands the driver one strings array per distinct statement text, so a per-array driver cache stays flat', () => {
        const toStatement = (attempts: number) => {
            const row = PSqlFragment.identifier('candidate');
            const predicate = PSqlFragment.of`${row}.ri_status = ${'NEW'} and ${row}.ri_attempts < ${attempts}`;
            return PSqlFragment.of`select * from resource_inbox candidate where ${predicate} limit ${1}`.toStatement();
        };
        const statements = Array.from({ length: 1_000 }, (_, attempts) => toStatement(attempts));
        const other = PSqlFragment.of`select * from resource_inbox candidate where candidate.ri_status = ${'NEW'}`
            .toStatement();

        expect(new Set(statements.map(([strings]) => strings)).size).toBe(1);
        expect(statements.map(([, , attempts]) => attempts)).toEqual(Array.from({ length: 1_000 }, (_, attempts) => attempts));
        expect(other[0]).not.toBe(statements[0][0]);
        expect(Object.isFrozen(statements[0][0])).toBe(true);
        expect(Object.isFrozen(statements[0][0].raw)).toBe(true);
    });

    it('keeps statements apart whose texts differ only in where the parameters split them', () => {
        const [first] = PSqlFragment.of`select ${1}, 2`.toStatement();
        const [second] = PSqlFragment.of`select , 2${1}`.toStatement();

        expect([...first]).toEqual(['select ', ', 2']);
        expect([...second]).toEqual(['select , 2', '']);
        expect(first).not.toBe(second);
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
