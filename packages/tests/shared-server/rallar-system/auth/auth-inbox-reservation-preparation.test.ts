import { Temporal } from '@js-temporal/polyfill';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { toAuthSessionContextId } from '@shared-server/rallar-system/auth/inbox/auth-app-inbox-routing.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { LogoutResponse } from '@shared/api/api-config.ts';
import { toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { Either } from '@shared/resilience/Either.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import {
    createAuthInboxTestHarness,
    createAuthInboxTestRuntime,
    runAuthInboxCommand
} from './auth-app-inbox-test-runtime.ts';

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

    it.each(['candidate', 'live-row'] as const)('uses the owned auth observation for %s', async (boundary) => {
        const observedAtMs = Date.now() - 60_000;
        const auth = createAuthInboxTestRuntime({
            runtimeRepository: new FakeRuntimeStateRepository(),
            serviceId: 'owned-clock-auth',
            credentialSecret: 'owned-clock-secret-0123456789abcdef',
            nowEpochMs: () => observedAtMs,
            newAuthMessageId: () => 'auth-owned-observation'
        });
        const input = {
            requestId: 'owned-clock-logout',
            session: {
                clientId: 'client-1',
                username: 'alice',
                sessionId: 'session-1',
                accessToken: 'absent-access-token',
                issuedAtEpochMs: 500,
                expiresAtEpochMs: 2_000
            }
        };
        const pending = auth.service.logoutSession(input);
        await auth.queue.waitForEntryCount();
        const candidate = (await auth.queue.readEntries())[0];
        await runAuthInboxCommand({ pending, queue: auth.queue, reader: auth.reader });
        const message = decodePersistedALMessage(candidate.resource);
        if (boundary === 'candidate') {
            expect(message.id.ts).toBe(observedAtMs);
            expect(message.audit?.createdTs).toBe(observedAtMs);
            expect(message.id.msgId).toBe('auth-owned-observation');
            const key = toAppQueueKey({
                topicId: AppInboxType.AUTH_SESSION_LOGOUT,
                contextId: toAuthSessionContextId(input.session.clientId, input.session.sessionId),
                resourceId: input.requestId
            });
            const legacy = newALUntargetedMessage(
                toAppQueueCreatedBy('auth-fact-reservation'),
                newALRoute(key.topicId, key.contextId, key.resourceId),
                AppInboxType.AUTH_SESSION_LOGOUT,
                JSON.parse(message.payload.resource)
            );
            expect(candidate.resource).toBe(JSON.stringify({
                ...legacy,
                id: { ...legacy.id, msgId: 'auth-owned-observation', ts: observedAtMs },
                audit: { ...legacy.audit, createdTs: observedAtMs }
            }));
            expect(candidate.key).toEqual(key);
            expect(candidate.audit.createdTs.toString()).toBe(
                Temporal.Instant.fromEpochMilliseconds(observedAtMs).toZonedDateTimeISO('UTC').toPlainDateTime().toString()
            );
            return;
        }

        const existing = {
            ...candidate,
            audit: { ...candidate.audit, expiryTs: Temporal.Instant.fromEpochMilliseconds(observedAtMs + 30_000) }
        };
        const before = JSON.stringify(existing);
        vi.spyOn(auth.queue, 'findAllByTopicAndResourceId').mockResolvedValue([existing]);
        const write = vi.spyOn(auth.queue, 'writeMaterializedIfAbsentOrReplaceExpired');
        const completion = Either.ofRight<AppInboxFailure, LogoutResponse>({ loggedOut: true });
        vi.spyOn(auth.service, 'processAuthIntentUntilCompletion').mockResolvedValue(completion);

        await expect(auth.service.logoutSession(input)).resolves.toEqual(completion);
        expect(write).not.toHaveBeenCalled();
        expect(JSON.stringify(existing)).toBe(before);
    });
});
