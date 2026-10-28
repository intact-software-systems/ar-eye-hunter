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
        vi.spyOn(auth.queue, 'writeMaterializedIfAbsentOrReplaceExpired')
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
            traceId: 'trace-auth-test',
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
        const retainedEntries = JSON.stringify(await auth.queue.readEntries());
        await expect(auth.service.logoutSession(input)).resolves.toEqual(result);
        expect(JSON.stringify(await auth.queue.readEntries())).toBe(retainedEntries);
        expect(hashObservations.length).toBeGreaterThan(0);
        expect(hashObservations.every((insideWrite) => !insideWrite)).toBe(true);
    });

    it.each(['logout-session', 'consume-agent-ticket'] as const)(
        'waits on the reserved %s row without enqueueing it a second time',
        async (kind) => {
            const auth = createAuthInboxTestHarness(new FakeRuntimeStateRepository());
            const enqueueIfAbsent = vi.spyOn(auth.reader, 'enqueueIfAbsent');
            const result = kind === 'logout-session'
                ? await runAuthInboxCommand({
                    pending: auth.service.logoutSession({
                        requestId: 'reserved-once-logout',
                        traceId: 'trace-auth-test',
                        session: {
                            clientId: 'client-1',
                            username: 'alice',
                            sessionId: 'session-1',
                            accessToken: 'absent-access-token',
                            issuedAtEpochMs: 500,
                            expiresAtEpochMs: 2_000
                        }
                    }),
                    queue: auth.queue,
                    reader: auth.reader
                })
                : await runAuthInboxCommand({
                    pending: auth.service.consumeAgentSessionTicket({
                        requestId: 'reserved-once-consume',
                        traceId: 'trace-auth-test',
                        ticket: 'absent-agent-ticket'
                    }),
                    queue: auth.queue,
                    reader: auth.reader
                });

            expect(result.left?.retry ?? null).toBeNull();
            expect(await auth.queue.readEntries()).toHaveLength(1);
            expect(enqueueIfAbsent).not.toHaveBeenCalled();
        }
    );

    it('wakes the queue for a replay that finds its intent still NEW, instead of waiting for the idle poll', async () => {
        let wakes = 0;
        const waitTraces: (string | undefined)[] = [];
        const auth = createAuthInboxTestRuntime({
            timing: (event) => {
                if (event.operation === 'wait-completion') {
                    waitTraces.push(event.traceId);
                }
            },
            runtimeRepository: new FakeRuntimeStateRepository(),
            serviceId: 'replay-wake-auth',
            credentialSecret: 'replay-wake-secret-0123456789abcdef',
            wakeOwningQueue: () => {
                wakes += 1;
            }
        });
        const session = {
            clientId: 'client-1',
            username: 'alice',
            sessionId: 'session-1',
            accessToken: 'absent-access-token',
            issuedAtEpochMs: 500,
            expiresAtEpochMs: 2_000
        };
        const original = auth.service.logoutSession({ requestId: 'replay-wake-logout', traceId: 'trace-auth-test', session });
        await vi.waitFor(() => expect(wakes).toBe(1));

        const replay = auth.service.replayLogoutSessionWithCredentialProof({
            requestId: 'replay-wake-logout',
            traceId: 'trace-replay-wake-logout',
            clientId: session.clientId,
            accessToken: session.accessToken
        });

        await vi.waitFor(() => expect(wakes).toBe(2));
        const result = await runAuthInboxCommand({ pending: original, queue: auth.queue, reader: auth.reader });
        expect(result.right).toEqual({ loggedOut: true });
        await expect(replay).resolves.toEqual(result);
        expect([...waitTraces].sort()).toEqual(['trace-auth-test', 'trace-replay-wake-logout']);
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
            traceId: 'trace-auth-test',
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
                id: { ...legacy.id, msgId: 'auth-owned-observation', ts: observedAtMs, traceId: message.id.traceId },
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

        await expect(auth.service.logoutSession(input)).resolves.toEqual(
            Either.ofRight<AppInboxFailure, LogoutResponse>({ loggedOut: true })
        );
        expect(write).not.toHaveBeenCalled();
        expect(JSON.stringify(existing)).toBe(before);
    });
});
