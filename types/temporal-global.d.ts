import type { Temporal as TemporalNamespace } from '@js-temporal/polyfill';

// Note: To avoid missing Temporal issues
declare global {
    var Temporal: typeof TemporalNamespace;

    namespace Temporal {
        type Duration = TemporalNamespace.Duration;
        type Instant = TemporalNamespace.Instant;
        type PlainDateTime = TemporalNamespace.PlainDateTime;
        type PlainTime = TemporalNamespace.PlainTime;
        type TimeUnit = TemporalNamespace.TimeUnit;
    }
}

export {};
