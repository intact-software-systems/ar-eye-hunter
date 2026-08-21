// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { createRallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/browser-adapter.ts';
import type { RallarBlackBoxTestResult } from '../../shared-test/rallar-bb-test/types.ts';

type HttpResultValue = Readonly<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: Readonly<Record<string, unknown>>;
}>;

function httpResultValue(result: RallarBlackBoxTestResult | undefined): HttpResultValue {
    expect(result?.ok).toBe(true);
    return result?.value as HttpResultValue;
}

describe('http.request result redaction', () => {
    it('redacts sensitive response headers and body fields in the recorded result and mirrored event', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            fetch: (async () =>
                new Response(
                    JSON.stringify({
                        profile: { username: 'alice' },
                        accessToken: 'live-access-token'
                    }),
                    {
                        status: 200,
                        headers: {
                            'content-type': 'application/json',
                            'x-session-cookie': 'session=live-cookie-value',
                            'x-rallar-ticket': 'live-ticket-value'
                        }
                    }
                )) as typeof fetch
        });

        const result = await runtime.execute({
            kind: 'http.request',
            commandId: 'http-sensitive-response',
            request: {
                url: 'https://api.example.test/api/session',
                method: 'GET'
            },
            response: {
                body: 'json'
            }
        });

        const value = httpResultValue(result);
        expect(value.status).toBe(200);
        expect(value.headers['x-session-cookie']).toBe('<redacted>');
        expect(value.headers['x-rallar-ticket']).toBe('<redacted>');
        expect(value.headers['content-type']).toBe('application/json');
        expect(value.body.accessToken).toBe('<redacted>');
        expect(value.body.profile).toEqual({ username: 'alice' });

        const cachedValue = httpResultValue(runtime.state().resultCache['http-sensitive-response']);
        expect(cachedValue.headers['x-session-cookie']).toBe('<redacted>');
        expect(cachedValue.body.accessToken).toBe('<redacted>');

        const mirroredEvent = runtime.state().events
            .find((event) => event.topic === 'rallar.bb.http.response');
        expect(mirroredEvent?.payload).toMatchObject({
            status: 200,
            headers: {
                'x-session-cookie': '<redacted>',
                'x-rallar-ticket': '<redacted>'
            },
            body: {
                accessToken: '<redacted>'
            }
        });
    });

    it('redacts the http result recorded for a rejected status code', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            fetch: (async () =>
                new Response(
                    JSON.stringify({ error: 'denied', refreshToken: 'live-refresh-token' }),
                    {
                        status: 403,
                        headers: {
                            'content-type': 'application/json',
                            authorization: 'Bearer leaked-server-echo'
                        }
                    }
                )) as typeof fetch
        });

        const result = await runtime.execute({
            kind: 'http.request',
            commandId: 'http-rejected-status',
            request: {
                url: 'https://api.example.test/api/denied',
                method: 'GET'
            },
            response: {
                body: 'json',
                acceptedStatusCodes: [200]
            }
        });

        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_HTTP_STATUS_NOT_ACCEPTED');
        const failedValue = result.value as HttpResultValue;
        expect(failedValue.headers.authorization).toBe('<redacted>');
        expect(failedValue.body.refreshToken).toBe('<redacted>');
        const errorDetails = result.error?.details as HttpResultValue;
        expect(errorDetails.headers.authorization).toBe('<redacted>');
        expect(errorDetails.body.refreshToken).toBe('<redacted>');
    });
});
