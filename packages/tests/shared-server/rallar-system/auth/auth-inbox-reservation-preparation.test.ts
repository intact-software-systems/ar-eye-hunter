import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAuthInboxTestHarness, runAuthInboxCommand } from './auth-app-inbox-test-runtime.ts';

describe('auth reservation preparation', () => {
    afterEach(() => vi.restoreAllMocks());

    it('hashes before the guarded write and reuses a known committed request', async () => {
        const auth = createAuthInboxTestHarness(new FakeRuntimeStateRepository());
        let writing = false;
        const hashObservations: boolean[] = [];
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
            hashObservations.push(writing);
            return await digest(...args);
        });
        const write = auth.queue.writeMaterializedIfAbsentOrReplaceExpired.bind(auth.queue);
        const writeSpy = vi.spyOn(auth.queue, 'writeMaterializedIfAbsentOrReplaceExpired')
            .mockImplementation(async (...args) => {
                writing = true;
                try {
                    return await write(...args);
                }
                finally {
                    writing = false;
                }
            });
        const input = {
            requestId: 'prepared-logout',
            session: {
                clientId: 'client-1',
                username: 'alice',
                sessionId: 'session-1',
                accessToken: 'absent-access-token',
                issuedAtEpochMs: 500,
                expiresAtEpochMs: 2_000
            }
        };
        const result = await runAuthInboxCommand({
            pending: auth.service.logoutSession(input),
            queue: auth.queue,
            reader: auth.reader
        });
        expect(result.right).toEqual({ loggedOut: true });
        await expect(auth.service.logoutSession(input)).resolves.toEqual(result);
        expect(writeSpy).toHaveBeenCalledTimes(1);
        expect(hashObservations.length).toBeGreaterThan(0);
        expect(hashObservations.every((insideWrite) => !insideWrite)).toBe(true);
    });
});
