const { schemaExec } = await vi.hoisted(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    return { schemaExec: vi.spyOn(PGlite.prototype, 'exec') };
});

import { createApiV1SchemaPGliteSql } from './create-api-v1-schema-pglite-sql.ts';

describe('importing createApiV1SchemaPGliteSql without opting into the template', () => {
    it('registers no hook that builds a template before the first test', () => {
        expect(createApiV1SchemaPGliteSql).toBeTypeOf('function');
        expect(schemaExec).not.toHaveBeenCalled();
    });
});
