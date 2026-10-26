import { Temporal } from '@js-temporal/polyfill';
import assert from 'node:assert/strict';

import { retryAfterAttempt } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';

import defaultsSource from '../../resources/configuration/defaults-config.json' with { type: 'json' };

import { ApiV1ConfigurationError } from '../../src/configuration/api-v1-configuration-error.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { readApiV1ConfigurationEnvironment } from '../../src/configuration/read-api-v1-configuration-environment.ts';
import { createApiV1MiddlewareResilience } from '../../src/middleware-resilience.ts';
import { toApiAppInboxServiceOptions } from '../../src/services/timing-service.ts';
import { validConfigurationProfileSource, validDecodeApiV1ConfigurationInput } from './api-v1-configuration-test-fixture.ts';

Deno.test('AppInbox retry configuration controls conflict delay, ordinary backoff and exhaustion independently', () => {
    const values: Record<string, string> = {
        RALLAR_APP_INBOX_MAX_ATTEMPTS: '9',
        RALLAR_APP_INBOX_MAX_RETRY_DELAY_MS: '400',
        RALLAR_APP_INBOX_CONFLICT_MAX_RETRY_DELAY_MS: '75'
    };
    const environment = readApiV1ConfigurationEnvironment({ get: (name) => values[name] });
    const input = validDecodeApiV1ConfigurationInput();
    const configuration = decodeApiV1Configuration({
        ...input,
        environmentSource: { ...environment.environmentSource, group: { roomOwnedAppDataBindings: [] } }
    });
    assert.deepEqual(configuration.appInbox.retry, { maxAttempts: 9, maxDelayMs: 400, conflictMaxDelayMs: 75 });
    assert.equal(toApiAppInboxServiceOptions(configuration.appInbox).conflictRetryMaxDelayMs, 75);
    const resilience = createApiV1MiddlewareResilience(configuration.topology.queueResilience, configuration.appInbox.retry);
    assert.equal(resilience.inbox.toWorkAdvertisementOptions().maxAttempts, 9);
    assert.deepEqual(retryAfterAttempt(resilience.inbox.retryPolicy, 8, 0), { status: 'retry', delayMs: 320 });
    assert.deepEqual(retryAfterAttempt(resilience.inbox.retryPolicy, 8, 1), { status: 'retry', delayMs: 480 });
    assert.deepEqual(retryAfterAttempt(resilience.inbox.retryPolicy, 9, 0.5), { status: 'failed', delayMs: null });
    for (const outbox of [resilience.outbox, resilience.appOutbox]) {
        assert.equal(outbox.retryPolicy.maxAttempts, 20);
        assert.equal(outbox.retryPolicy.maxDelayMs, 30_000);
    }
});

Deno.test('AppInbox retry defaults bound conflict backoff and allow profile and environment overrides', () => {
    const input = { ...validDecodeApiV1ConfigurationInput(), defaultsSource };
    assert.deepEqual(decodeApiV1Configuration(input).appInbox.retry, {
        maxAttempts: 20,
        maxDelayMs: 30_000,
        conflictMaxDelayMs: 1200
    });
    input.profileSource = { ...validConfigurationProfileSource(), appInbox: { retry: { maxAttempts: 30, maxDelayMs: 5000, conflictMaxDelayMs: 500 } } };
    input.environmentSource = { group: { roomOwnedAppDataBindings: [] }, appInbox: { retry: { maxAttempts: 40 } } };
    assert.deepEqual(decodeApiV1Configuration(input).appInbox.retry, {
        maxAttempts: 40,
        maxDelayMs: 5000,
        conflictMaxDelayMs: 500
    });
});

Deno.test('AppInbox rejects invalid attempt and delay bounds instead of silently replacing them', () => {
    for (const field of ['maxAttempts', 'maxDelayMs', 'conflictMaxDelayMs']) {
        for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
            const input = validDecodeApiV1ConfigurationInput();
            input.environmentSource = { group: { roomOwnedAppDataBindings: [] }, appInbox: { retry: { [field]: value } } };
            assert.throws(
                () => decodeApiV1Configuration(input),
                (error) =>
                    error instanceof ApiV1ConfigurationError &&
                    error.issues.some((issue) => issue.path === `appInbox.retry.${field}` && issue.code === 'invalid-integer')
            );
        }
    }
});

Deno.test('AppInbox delay bounds keep positive jitter and persisted timestamps representable', () => {
    const input = validDecodeApiV1ConfigurationInput();
    input.environmentSource = {
        group: { roomOwnedAppDataBindings: [] },
        appInbox: { retry: { maxDelayMs: 2_592_000_000, conflictMaxDelayMs: 2_592_000_000 } }
    };
    const configuration = decodeApiV1Configuration(input);
    const policy = createApiV1MiddlewareResilience(configuration.topology.queueResilience, configuration.appInbox.retry).inbox.retryPolicy;
    const retry = retryAfterAttempt(policy, 19, 1);
    assert.deepEqual(retry, { status: 'retry', delayMs: 3_110_400_000 });
    assert.equal(Temporal.Instant.from('2026-01-01T00:00:00Z').add({ milliseconds: retry.delayMs! }).toString(), '2026-02-06T00:00:00Z');
    for (const field of ['maxDelayMs', 'conflictMaxDelayMs']) {
        input.environmentSource = { group: { roomOwnedAppDataBindings: [] }, appInbox: { retry: { [field]: 2_592_000_001 } } };
        assert.throws(
            () => decodeApiV1Configuration(input),
            (error) => error instanceof ApiV1ConfigurationError && error.issues.some((issue) => issue.path === `appInbox.retry.${field}`)
        );
    }
});
