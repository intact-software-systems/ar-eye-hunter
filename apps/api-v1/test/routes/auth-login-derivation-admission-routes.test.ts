import assert from 'node:assert/strict';

import { AuthPasswordDerivationAdmission } from '@shared-server/rallar-system/auth/credentials/auth-password-derivation-admission.ts';
import { Either } from '@shared/resilience/Either.ts';

import { createConfigRouteTestApp, createConfigRouteTestDependencies } from './config-route-test-runtime.ts';

const HELD_RESPONSE_WINDOW_MS = 200;

Deno.test('login against a static client completes while every derivation slot is held', async () => {
    const admission = new AuthPasswordDerivationAdmission({ maxConcurrentDerivations: 1 });
    let releaseHeldSlot = (): void => {};
    const held = admission.admit(() =>
        new Promise<void>((resolve) => {
            releaseHeldSlot = resolve;
        })
    );
    const app = createConfigRouteTestApp({
        passwordDerivationAdmission: admission,
        authentication: {
            ...createConfigRouteTestDependencies().authentication,
            staticClients: [{ clientId: 'alice', username: 'alice', password: 'password' }]
        },
        authUserRepository: {
            findByNormalizedUsernameEntry: () => Promise.resolve(undefined)
        } as never,
        appAuthInbox: ({
            issueSession: () =>
                Promise.resolve(Either.ofRight({
                    clientId: 'alice',
                    username: 'alice',
                    accessToken: 'login-access-token',
                    sessionId: 'login-session',
                    expiresAtEpochMs: 61_000
                }))
        }) as never
    });

    const login = await raceAgainstHeldWindow(
        Promise.resolve(app.request('/api/auth/login/requests/LoginMutationRequest_01234', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'alice', password: 'password' })
        }))
    );
    releaseHeldSlot();
    await held;

    if (login === 'held') {
        throw new Error('Login waited for a derivation slot it does not need');
    }
    assert.equal(login.status, 200, await login.clone().text());
});

async function raceAgainstHeldWindow(response: Promise<Response>): Promise<Response | 'held'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const window = new Promise<'held'>((resolve) => {
        timer = setTimeout(() => resolve('held'), HELD_RESPONSE_WINDOW_MS);
    });
    try {
        return await Promise.race([response, window]);
    }
    finally {
        clearTimeout(timer);
    }
}
