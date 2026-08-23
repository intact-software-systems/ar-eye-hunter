import type { AppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';
import {
    createConsoleRallarTimingSink,
    type RallarTimingSink
} from '@shared-server/rallar-system/observability/timing.ts';
import type {
    ApiV1AppInboxConfiguration,
    ApiV1ObservabilityConfiguration
} from '../configuration/api-v1-configuration.ts';
export {
    createApiStateSnapshotReadSelectors
} from './create-api-state-snapshot-read-selectors.ts';

export function createApiTimingSink(
    configuration: ApiV1ObservabilityConfiguration
): RallarTimingSink {
    return createConsoleRallarTimingSink({
        enabled: configuration.timingLogs
    });
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
