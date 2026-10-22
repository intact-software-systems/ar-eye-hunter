import type { AppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import {
    createConsoleRallarTimingSink,
    type RallarTimingSink
} from '@shared-server/rallar-system/observability/timing.ts';
import type {
    ApiV1AppInboxConfiguration,
    ApiV1ObservabilityConfiguration
} from '../configuration/api-v1-configuration.ts';

export function createApiTimingSink(
    configuration: ApiV1ObservabilityConfiguration
): RallarTimingSink {
    return createConsoleRallarTimingSink({
        enabled: configuration.timingLogs
    });
}

/** The sink only while timing logs are on, so a consumer builds its timing records only while they are written. */
export function toTimingOnSink(
    configuration: ApiV1ObservabilityConfiguration,
    timing: RallarTimingSink
): RallarTimingSink | undefined {
    return configuration.timingLogs ? timing : undefined;
}

export function toApiAppInboxServiceOptions(
    configuration: ApiV1AppInboxConfiguration
): AppInboxOptions {
    return {
        phaseTiming: configuration.phaseTiming,
        waitMaxElapsedMsecs: configuration.completionWait.maxElapsedMs,
        waitRetryIntervalMsecs: configuration.completionWait.retryIntervalMs,
        waitMaxRetryIntervalMsecs: configuration.completionWait.maxRetryIntervalMs,
        waitJitterRatio: configuration.completionWait.jitterRatio
    };
}
