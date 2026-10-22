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

Deno.test('a shape is the first sixty characters of the statement text, parameters as marks, with whitespace collapsed', () => {
    const census = new PostgresStatementCensus();
    const text = `select ${'column_name, '.repeat(20)}`;

    census.record({ strings: toStrings([text]), values: [], executorWaitMs: 0 });
    census.record({ strings: toStrings(['\n  select\n    ', '::int as ordinal,\n  exists(', ')']), values: [1, 2], executorWaitMs: 0 });

    assert.deepEqual(census.takeShapes().map((shape) => shape.shape).sort(), [
        'select ?::int as ordinal, exists(?)',
        text.slice(0, 60)
    ]);
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
