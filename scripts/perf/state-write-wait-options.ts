import { type AppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import {
    DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
    resourceInboxRetryHorizonMs
} from '@shared/queuebox/ResourceInboxRetryPolicy.ts';

// Bounds transaction and queue-processing overhead beyond the complete retry schedule.
export const STATE_WRITE_BENCHMARK_APP_INBOX_PROCESSING_MARGIN_MS = 60_000;

const maximumRetryDelayMs = resourceInboxRetryHorizonMs(
    DEFAULT_RESOURCE_INBOX_RETRY_POLICY
);
const waitMaxElapsedMsecs = maximumRetryDelayMs + STATE_WRITE_BENCHMARK_APP_INBOX_PROCESSING_MARGIN_MS;

if (!Number.isSafeInteger(waitMaxElapsedMsecs) || waitMaxElapsedMsecs <= 0) {
    throw new RangeError('State-write benchmark AppInbox wait budget is invalid');
}

const pollOptions = {
    waitMaxElapsedMsecs,
    waitRetryIntervalMsecs: 1,
    waitMaxRetryIntervalMsecs: 5,
    waitJitterRatio: 0
} as const satisfies AppInboxOptions;

export const STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS = {
    client: { ...pollOptions },
    group: { ...pollOptions }
} as const satisfies Readonly<Record<'client' | 'group', AppInboxOptions>>;
