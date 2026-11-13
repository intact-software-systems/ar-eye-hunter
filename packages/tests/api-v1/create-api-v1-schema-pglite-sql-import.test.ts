const { executedSql } = await vi.hoisted(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const executed: string[] = [];
    const exec = PGlite.prototype.exec;
    PGlite.prototype.exec = function (this: InstanceType<typeof PGlite>, ...args: Parameters<typeof exec>) {
        executed.push(args[0]);
        return exec.apply(this, args);
    };
    return { executedSql: executed };
});

import { createApiV1SchemaPGliteSql } from './create-api-v1-schema-pglite-sql.ts';

describe('importing createApiV1SchemaPGliteSql without opting into the template', () => {
    it('registers no hook that builds a template before the first test', () => {
        expect(createApiV1SchemaPGliteSql).toBeTypeOf('function');
        expect(executedSql).toEqual([]);
    });
});
