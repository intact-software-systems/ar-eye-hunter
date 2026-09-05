import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { createPGliteSqlClient } from '../../src/db/pglite-sql-adapter.ts';

const directInstant = new Date('2026-08-01T02:03:04.567Z');
const arrayInstants = [
    new Date('2026-08-01T02:03:05.678Z'),
    new Date('2026-08-01T02:03:06.789Z')
] as const;

assert.notEqual(new Date().getTimezoneOffset(), 0, 'The subprocess must run outside UTC.');
const raw = new PGlite();
await raw.waitReady;
await raw.query('set time zone \'America/New_York\'');
const sql = createPGliteSqlClient(raw);
try {
    const [row] = await sql<{ timezone: string; dateValue: Date; stringValue: Date; ordinary: string; }[]>`
    select current_setting('TimeZone') as timezone,
           ${directInstant}::timestamp at time zone 'UTC' as "dateValue",
           ${directInstant.toISOString()}::timestamp at time zone 'UTC' as "stringValue",
           ${'ordinary-text:2026-08-01T02:03:04.567Z'}::text as ordinary
  `;
    assert.equal(row?.timezone, 'America/New_York');
    assert.equal(row?.dateValue.toISOString(), directInstant.toISOString());
    assert.equal(row?.stringValue.toISOString(), directInstant.toISOString());
    assert.equal(row?.ordinary, 'ordinary-text:2026-08-01T02:03:04.567Z');
    const [timestampRow] = await sql<{ value: string; }[]>`
    select ${'2026-08-01T02:03:04.567890'}::timestamp as value
  `;
    assert.equal(timestampRow?.value, '2026-08-01 02:03:04.56789');
    const rows = await sql<{ value: Date; }[]>`
    select value::timestamp at time zone 'UTC' as value
    from (values (${arrayInstants[0].toISOString()}), (${arrayInstants[1].toISOString()})) as values(value)
    where value::timestamp in ${sql(arrayInstants)}
    order by value
  `;
    assert.deepEqual(
        rows.map((row) => row.value.toISOString()),
        arrayInstants.map((value) => value.toISOString())
    );
}
finally {
    await sql.close();
}
