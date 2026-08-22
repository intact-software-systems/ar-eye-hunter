import type { AppInboxServiceOptions } from '@shared-server/rallar-system/services/AppInboxService.ts';
import { createConsoleRallarTimingSink, type RallarTimingSink } from '@shared-server/rallar-system/services/timing.ts';
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
): AppInboxServiceOptions {
    return {
        phaseTiming: configuration.phaseTiming,
        waitMaxElapsedMsecs: configuration.completionWait.maxElapsedMs,
        waitRetryIntervalMsecs: configuration.completionWait.retryIntervalMs,
        waitMaxRetryIntervalMsecs: configuration.completionWait.maxRetryIntervalMs,
        waitJitterRatio: configuration.completionWait.jitterRatio
    };
}
