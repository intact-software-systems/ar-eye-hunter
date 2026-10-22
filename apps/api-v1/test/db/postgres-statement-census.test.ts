import assert from 'node:assert/strict';

import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type { Timers } from '@shared/resilience/timers.ts';

import { PostgresStatementCensus, startPostgresStatementCensusTiming } from '../../src/db/postgres-statement-census.ts';

interface ManualTimers extends Timers {
    runDue(): void;
}

Deno.test('the census emits one statement-census line per interval that saw statements, and none after its stop', () => {
    const census = new PostgresStatementCensus();
    const events: RallarTimingEvent[] = [];
    const timers = createManualTimers();
    const stop = startPostgresStatementCensusTiming({
        census,
        timers,
        timing: (event) => events.push(event),
        serviceId: 'server-1',
        intervalMs: 5_000
    });

    timers.runDue();
    assert.equal(events.length, 0, 'an interval without statements records nothing');
    census.record({ strings: toStrings(['select one from rows where id = ', '']), values: ['row-1'], executorWaitMs: 2 });
    census.record({ strings: toStrings(['select one from rows where id = ', '']), values: ['row-22'], executorWaitMs: 3 });
    census.record({ strings: toStrings(['\n  delete   from rows', '']), values: [null], executorWaitMs: 9 });
    timers.runDue();

    assert.equal(events.length, 1);
    const [event] = events;
    assert.deepEqual(
        [event?.component, event?.operation, event?.serviceId, event?.status, event?.durationMs],
        ['postgres', 'statement-census', 'server-1', 'ok', 5_000]
    );
    assert.deepEqual(event?.details, {
        statements: 3,
        executorWaitMs: 14,
        parameterChars: 11,
        shapes: JSON.stringify([
            { shape: 'delete from rows?', count: 1, executorWaitMs: 9, parameterChars: 0 },
            { shape: 'select one from rows where id = ?', count: 2, executorWaitMs: 5, parameterChars: 11 }
        ])
    });

    stop();
    census.record({ strings: toStrings(['select 1']), values: [], executorWaitMs: 1 });
    timers.runDue();
    assert.equal(events.length, 1);
});

Deno.test('a shape is the whole statement text, parameters as marks, with whitespace collapsed', () => {
    const census = new PostgresStatementCensus();
    const text = `select ${'column_name, '.repeat(20)}`;

    census.record({ strings: toStrings([text]), values: [], executorWaitMs: 0 });
    census.record({ strings: toStrings(['\n  select\n    ', '::int as ordinal,\n  exists(', ')']), values: [1, 2], executorWaitMs: 0 });

    assert.deepEqual(census.takeShapes().map((shape) => shape.shape).sort(), [
        'select ?::int as ordinal, exists(?)',
        text.trim()
    ]);
});

Deno.test('statements whose texts share their first sixty characters stay two shapes, each truncated only on its line', () => {
    const census = new PostgresStatementCensus();
    const events: RallarTimingEvent[] = [];
    const timers = createManualTimers();
    const prefix = 'select * from resource_inbox where ri_type_id = any(';
    startPostgresStatementCensusTiming({ census, timers, timing: (event) => events.push(event), serviceId: 'server-1', intervalMs: 5_000 });

    census.record({ strings: toStrings([prefix, '::text[]) and ri_status = \'RETRY\' limit 1']), values: [[]], executorWaitMs: 4 });
    census.record({ strings: toStrings([prefix, '::text[]) and ri_status = \'RESERVED\' limit 1']), values: [[]], executorWaitMs: 1 });
    timers.runDue();

    const shapes = JSON.parse(String(events[0]?.details?.shapes)) as { shape: string; count: number; executorWaitMs: number; }[];
    assert.deepEqual(shapes.map(({ count, executorWaitMs }) => [count, executorWaitMs]), [[1, 4], [1, 1]]);
    assert.deepEqual(shapes.map(({ shape }) => shape.length), [60, 60]);
});

Deno.test('a parameter counts its scalar text: an array its scalar elements, a structured value nothing', () => {
    const census = new PostgresStatementCensus();

    census.record({
        strings: toStrings(['select ', ', ', ', ', '']),
        values: [['ab', { kind: 'key' }, 3], { selector: 'never serialized' }, new Date(0)],
        executorWaitMs: 0
    });

    assert.deepEqual(census.takeShapes().map((shape) => shape.parameterChars), [27]);
});

function toStrings(texts: readonly string[]): TemplateStringsArray {
    return Object.assign([...texts], { raw: [...texts] });
}

function createManualTimers(): ManualTimers {
    let pending: (() => void | Promise<void>) | undefined;
    return {
        nowMs: () => 0,
        schedule: (run) => {
            pending = run;
            return () => {
                pending = undefined;
            };
        },
        runDue: () => {
            const run = pending;
            pending = undefined;
            void run?.();
        }
    };
}
