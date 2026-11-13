import { readApiV1InMemorySchemaSql } from '../../../apps/api-v1/src/db/in-memory-schema-bootstrap.ts';
import { createPGliteSqlClient, PGlite, type PGliteSql } from '../../../apps/api-v1/src/db/pglite-sql-adapter.ts';
import { createApiV1SchemaPGliteSql, initApiV1SchemaPGliteTemplate } from './create-api-v1-schema-pglite-sql.ts';

describe('createApiV1SchemaPGliteSql', () => {
    initApiV1SchemaPGliteTemplate();

    it('gives each test a private database that neither shares writes nor changes the template', async () => {
        const first = await openClone();
        const second = await openClone();
        await first.exec(`create table clone_probe (id int); insert into clone_probe values (1)`);

        const later = await openClone();

        expect(await readRelation(first, 'clone_probe')).toBe('clone_probe');
        expect(await readRelation(second, 'clone_probe')).toBeNull();
        expect(await readRelation(later, 'clone_probe')).toBeNull();
    });

    it('holds the same schema and session settings as a freshly created instance', async () => {
        const clone = await openClone();
        const fresh = await openFreshSchemaInstance();

        expect(await readSchemaCatalog(clone)).toEqual(await readSchemaCatalog(fresh));
        expect((await readSchemaCatalog(clone)).length).toBeGreaterThan(0);
        expect(await readSessionSettings(clone)).toEqual(await readSessionSettings(fresh));
        expect(await readSessionSetting(clone, 'TimeZone')).toBe(await readSessionSetting(fresh, 'TimeZone'));
    });
});

// Two template lifecycles in one module instance, as a run without per-file isolation would give two test files.
describe.each(['first', 'second'])('the %s template lifecycle in one process', () => {
    initApiV1SchemaPGliteTemplate();

    it('clones a working database', async () => {
        expect(await readRelation(await openClone(), 'resource_inbox')).toBe('resource_inbox');
    });
});

async function openClone(): Promise<PGliteSql> {
    const sql = await createApiV1SchemaPGliteSql();
    onTestFinished(() => sql.close());
    return sql;
}

/** The reference a clone must match: a new instance with the schema applied in place. */
async function openFreshSchemaInstance(): Promise<PGliteSql> {
    const sql = createPGliteSqlClient(new PGlite());
    onTestFinished(() => sql.close());
    await sql.exec(await readApiV1InMemorySchemaSql());
    return sql;
}

async function readRelation(sql: PGliteSql, name: string): Promise<string | null> {
    const [row] = await sql<{ relation: string | null; }[]>`select to_regclass(${name})::text as relation`;
    return row?.relation ?? null;
}

async function readSchemaCatalog(sql: PGliteSql): Promise<readonly string[]> {
    const rows = await sql<{ entry: string; }[]>`
        select 'table ' || tablename as entry from pg_tables where schemaname = 'public'
        union all select 'index ' || indexname || ' ' || indexdef from pg_indexes where schemaname = 'public'
        union all select 'function ' || p.oid::regprocedure::text from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
        union all select 'trigger ' || tgname || ' on ' || tgrelid::regclass::text from pg_trigger where not tgisinternal
        union all select 'column ' || table_name || '.' || column_name || ' ' || data_type || ' ' || coalesce(column_default, '')
            from information_schema.columns where table_schema = 'public'
        order by entry`;
    return rows.map((row) => row.entry);
}

async function readSessionSettings(sql: PGliteSql): Promise<readonly string[]> {
    const rows = await sql<{ entry: string; }[]>`
        select name || '=' || coalesce(setting, '') as entry from pg_settings order by name`;
    return rows.map((row) => row.entry);
}

async function readSessionSetting(sql: PGliteSql, name: string): Promise<string> {
    const [row] = await sql<{ setting: string; }[]>`select current_setting(${name}) as setting`;
    return row?.setting ?? '';
}
