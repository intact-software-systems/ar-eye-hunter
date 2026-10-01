import { Temporal } from '@js-temporal/polyfill';
import { vi } from 'vitest';

export interface TemporalParseCounts {
    readonly instant: number;
    readonly plainTime: number;
    readonly plainDateTime: number;
}

export const NO_TEMPORAL_PARSES: TemporalParseCounts = {
    instant: 0,
    plainTime: 0,
    plainDateTime: 0
};

export function recordTemporalParses(run: () => void): TemporalParseCounts {
    const instant = vi.spyOn(Temporal.Instant, 'from');
    const plainTime = vi.spyOn(Temporal.PlainTime, 'from');
    const plainDateTime = vi.spyOn(Temporal.PlainDateTime, 'from');
    try {
        run();
        return {
            instant: instant.mock.calls.length,
            plainTime: plainTime.mock.calls.length,
            plainDateTime: plainDateTime.mock.calls.length
        };
    }
    finally {
        instant.mockRestore();
        plainTime.mockRestore();
        plainDateTime.mockRestore();
    }
}
