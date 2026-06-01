import { Temporal } from '@js-temporal/polyfill';
import { assertEquals } from 'https://deno.land';

Deno.test('QBox: duration is exceeded', () => {
    const start = Temporal.Now.instant();
    const duration = Temporal.Duration.from({ seconds: 5 });

    // Set a breakpoint on the next line
    const future = start.add(duration);

    assertEquals(future.epochMilliseconds, start.epochMilliseconds + 5);
});
