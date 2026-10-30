import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { createRallarALOutboundCapturedPolicyTiming } from '@shared-server/rallar-system/observability/al-outbound-captured-policy-timing.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import {
    newALBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs } from '@shared/al-contracts/al-policy.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { IndexedDbAdmissionReadSession } from '@shared/alm/indexed-db-admission-read-session.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { toALOutboundSentMessageKey } from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import { createALOutboundAdmissionStore, type ALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { captureALOutboundPolicy, type ALStoredOutboundMessage } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import { ALOutboundCapturedPolicyTiming } from '@shared/alm/outbound/admission/al-outbound-captured-policy-timing.ts';
import {
    captureALOutboundCreationExpiry,
    toALOutboundIdentityEntry,
    toALOutboundMessageReference
} from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { toWsQueueBoxServerCapturedSendInput } from '@shared/services/ws-queue-box-server/scope/to-ws-queue-box-server-captured-send-input.ts';
import { WsQueueBoxServerDeliveryReporting } from '@shared/services/ws-queue-box-server/ws-queue-box-server-delivery-reporting.ts';
import { WsQueueBoxServerLiveDelivery } from '@shared/services/ws-queue-box-server/ws-queue-box-server-live-delivery.ts';
import { WsQueueBoxServerTargetResolution } from '@shared/services/ws-queue-box-server/ws-queue-box-server-target-resolution.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../websocket/test-web-socket.ts';

import '../../setup-browser-indexeddb.ts';

// Corruption scenarios deliberately replace the stored reference after the row is written.
interface CapturedAudienceStoredMessage extends Omit<ALStoredOutboundMessage, 'reference'> {
    reference: ALStoredOutboundMessage['reference'];
}

interface CapturedAudienceFixture {
    readonly store: ALOutboundAdmissionStore<never>;
    readonly backend: InMemoryAdmissionBackend;
    readonly state: ALAdmissionMemoryState;
    readonly stored: CapturedAudienceStoredMessage;
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
}

describe('captured outbound audience read', () => {
    afterEach(() => vi.restoreAllMocks());

    it('starts the canonical identity read only after the stored admission read completes', async () => {
        const fixture = await createFixture(['session-a']);
        const storedEntered = Promise.withResolvers<void>();
        const releaseStored = Promise.withResolvers<void>();
        const read = fixture.backend.read.bind(fixture.backend);
        vi.spyOn(fixture.backend, 'read').mockImplementation(async (key, decode) => {
            storedEntered.resolve();
            await releaseStored.promise;
            return await read(key, decode);
        });
        const identityRead = vi.spyOn(fixture.backend, 'readWork');
        onTestFinished(() => releaseStored.resolve());

        const policy = fixture.store.readCapturedPolicy(fixture.message, fixture.entry);
        await storedEntered.promise;
        expect(identityRead).not.toHaveBeenCalled();
        releaseStored.resolve();
        await expect(policy).resolves.toMatchObject({ admittedAudience: ['session-a'] });
        expect(identityRead).toHaveBeenCalledOnce();
    });

    it('reports disjoint stored, reference, and identity phases for a serial read', async () => {
        const observations: ALOutboundCapturedPolicyTiming.Observation[] = [];
        let monotonicMs = 0;
        const fixture = await createFixture(['session-a'], undefined, {
            readMonotonicMs: () => monotonicMs,
            readEpochMs: () => 10_000,
            record: (observation) => observations.push(observation)
        });
        const storedEntered = Promise.withResolvers<void>();
        const identityEntered = Promise.withResolvers<void>();
        const releaseStored = Promise.withResolvers<void>();
        const releaseIdentity = Promise.withResolvers<void>();
        const read = fixture.backend.read.bind(fixture.backend);
        const readWork = fixture.backend.readWork.bind(fixture.backend);
        vi.spyOn(fixture.backend, 'read').mockImplementation(async (key, decode) => {
            storedEntered.resolve();
            await releaseStored.promise;
            return await read(key, decode);
        });
        vi.spyOn(fixture.backend, 'readWork').mockImplementation(async (key) => {
            identityEntered.resolve();
            await releaseIdentity.promise;
            return await readWork(key);
        });
        onTestFinished(() => {
            releaseStored.resolve();
            releaseIdentity.resolve();
        });

        const policy = fixture.store.readCapturedPolicy(fixture.message, fixture.entry);
        await storedEntered.promise;
        monotonicMs = 10;
        releaseStored.resolve();
        await identityEntered.promise;
        expect(observations).toEqual([]);
        monotonicMs = 25;
        releaseIdentity.resolve();
        await expect(policy).resolves.toMatchObject({ admittedAudience: ['session-a'] });
        expect(observations[0]).toMatchObject({
            availability: 'available',
            phases: {
                readStoredMessageElapsedMs: 10,
                queueIdentityReadElapsedMs: 15,
                ownerElapsedMs: 25
            }
        });
        const observation = observations[0];
        if (observation?.availability !== 'available') {
            throw new Error('Expected available timing after both reads settled');
        }
        const phases = observation.phases;
        expect(
            phases.ownerEntryElapsedMs + phases.readStoredMessageElapsedMs + phases.referenceValidationElapsedMs +
                phases.queueIdentityReadElapsedMs + phases.canonicalValidationElapsedMs + phases.sessionReturnElapsedMs
        ).toBe(phases.ownerElapsedMs);
    });

    it('does not start the identity read after a stored admission failure and permits recovery', async () => {
        const fixture = await createFixture(['session-a']);
        const storedFailure = new Error('stored read failed');
        vi.spyOn(fixture.backend, 'read').mockRejectedValueOnce(storedFailure);
        const identityRead = vi.spyOn(fixture.backend, 'readWork');

        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry)).rejects.toBe(storedFailure);
        expect(identityRead).not.toHaveBeenCalled();
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .resolves.toMatchObject({ admittedAudience: ['session-a'] });
        expect(identityRead).toHaveBeenCalledOnce();
    });

    it('rejects stored reference corruption before reading canonical identity', async () => {
        const fixture = await createFixture(['session-a']);
        const reference = fixture.stored.reference;
        fixture.stored.reference = { ...reference, scope: 'wrong-scope' };
        const identityRead = vi.spyOn(fixture.backend, 'readWork');

        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        expect(identityRead).not.toHaveBeenCalled();
        fixture.stored.reference = reference;
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .resolves.toMatchObject({ admittedAudience: ['session-a'] });
    });

    it('keeps a genuine IndexedDB read session open until a held identity read settles', async () => {
        const fixture = await createFixture(['session-a']);
        const identityEntered = Promise.withResolvers<void>();
        const releaseIdentity = Promise.withResolvers<void>();
        let holdIdentity = true;
        const backend = new IndexedDbAdmissionBackend({
            dbName: `captured-policy-${crypto.randomUUID()}`,
            storeName: 'entries',
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {},
            nowMs: Date.now,
            newWriteToken: crypto.randomUUID.bind(crypto),
            observer: {
                observe: (operation) => {
                    if (operation.kind === 'work-read' && holdIdentity) {
                        holdIdentity = false;
                        identityEntered.resolve();
                        return releaseIdentity.promise;
                    }
                }
            }
        });
        onTestFinished(async () => {
            releaseIdentity.resolve();
            await backend.close();
        });
        await backend.ready();
        const key = toALOutboundSentMessageKey('server-namespace', fixture.message.id.msgId);
        await backend.write(async (write) => {
            await write.set(key, fixture.stored, Date.now() + 120_000);
        });
        await backend.workQueue.enqueue(toALOutboundIdentityEntry(
            fixture.stored.reference,
            fixture.entry,
            fixture.stored.creationExpiry
        ));
        const store = createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: 'server-scope',
            namespace: 'server-namespace',
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention(),
            decodePrepared: () => {
                throw new TypeError('No prepared messages');
            }
        });
        const close = vi.spyOn(IndexedDbAdmissionReadSession.prototype, 'close');
        const policy = store.readCapturedPolicy(fixture.message, fixture.entry);
        await identityEntered.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(close).not.toHaveBeenCalled();
        releaseIdentity.resolve();
        await expect(policy).resolves.toMatchObject({ admittedAudience: ['session-a'] });
        expect(close).toHaveBeenCalled();

        await backend.write(async (write) => {
            await write.set(key, { ...fixture.stored, reference: { ...fixture.stored.reference, scope: 'wrong-scope' } }, Date.now() + 120_000);
        });
        await expect(store.readCapturedPolicy(fixture.message, fixture.entry))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        await backend.write(async (write) => {
            await write.set(key, fixture.stored, Date.now() + 120_000);
        });
        await expect(store.readCapturedPolicy(fixture.message, fixture.entry))
            .resolves.toMatchObject({ admittedAudience: ['session-a'] });
    });

    it('uses the live delivery expiry guard when a policy read crosses the message deadline', async () => {
        const fixture = await createFixture(['session-a']);
        const deadline = resolveALMessageExpireAtMs(fixture.message)!;
        const clock = {
            epochMs: deadline - 1,
            nowMs() {
                return this.epochMs;
            }
        };
        const socket = new JsonWebSocketServer();
        const recipient = new TestWebSocket('ws://session-a');
        recipient.open();
        socket.addConnection(new ConnectionContext({ id: 'session-a', socket: recipient }));
        const live = new WsQueueBoxServerLiveDelivery({
            socket,
            clock,
            targetResolution: new WsQueueBoxServerTargetResolution({
                socket,
                targetResolver: { requiresFrozenAudience: () => false, resolveBroadcastRecipients: () => [{ peerId: 'session-a', connectionId: 'session-a' }] }
            }),
            deliveryReporting: new WsQueueBoxServerDeliveryReporting({}),
            readAuthenticatedConnectionScope: () => ({
                scope: { applicationId: 'app', workspaceId: 'workspace' },
                expiresAtEpochMs: deadline + 60_000
            })
        });
        const storedEntered = Promise.withResolvers<void>();
        const releaseStored = Promise.withResolvers<void>();
        const read = fixture.backend.read.bind(fixture.backend);
        vi.spyOn(fixture.backend, 'read').mockImplementation(async (key, decode) => {
            storedEntered.resolve();
            await releaseStored.promise;
            return await read(key, decode);
        });
        onTestFinished(() => releaseStored.resolve());

        const reading = fixture.store.readCapturedPolicy(fixture.message, fixture.entry);
        await storedEntered.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        clock.epochMs = deadline;
        releaseStored.resolve();
        const policy = await reading;
        const send = live.sendToTargetsWithResult(toWsQueueBoxServerCapturedSendInput({
            message: fixture.message,
            key: fixture.entry.key,
            policy,
            eligibleSessionIds: undefined
        }));
        expect(send).toMatchObject({ status: 'expired', sentCount: 0 });
        expect(recipient.sent).toEqual([]);
    });

    it('attributes a held stored-message read at the real admission-store boundary', async () => {
        const observations: ALOutboundCapturedPolicyTiming.Observation[] = [];
        let monotonicMs = 0;
        const fixture = await createFixture(['session-a'], undefined, {
            readMonotonicMs: () => monotonicMs,
            readEpochMs: () => 10_000,
            record: (observation) => observations.push(observation)
        });
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const read = fixture.backend.read.bind(fixture.backend);
        vi.spyOn(fixture.backend, 'read').mockImplementation(async (key, decode) => {
            if (key === toALOutboundSentMessageKey('server-namespace', fixture.message.id.msgId)) {
                entered.resolve();
                await release.promise;
            }
            return await read(key, decode);
        });
        const policy = fixture.store.readCapturedPolicy(fixture.message, fixture.entry);
        onTestFinished(() => release.resolve());
        await entered.promise;
        expect(observations).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        monotonicMs = 40;
        release.resolve();
        await expect(policy).resolves.toMatchObject({ admittedAudience: ['session-a'] });
        expect(observations).toHaveLength(1);
        expect(observations[0]).toMatchObject({
            availability: 'available',
            phases: { readStoredMessageElapsedMs: 40, queueIdentityReadElapsedMs: 0 }
        });
    });

    it('attributes a held identity read separately from decoded stored-message work', async () => {
        const observations: ALOutboundCapturedPolicyTiming.Observation[] = [];
        let monotonicMs = 0;
        const fixture = await createFixture(['session-a'], undefined, {
            readMonotonicMs: () => monotonicMs,
            readEpochMs: () => 10_000,
            record: (observation) => observations.push(observation)
        });
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const readWork = fixture.backend.readWork.bind(fixture.backend);
        vi.spyOn(fixture.backend, 'readWork').mockImplementation(async (key) => {
            entered.resolve();
            await release.promise;
            return await readWork(key);
        });
        const policy = fixture.store.readCapturedPolicy(fixture.message, fixture.entry);
        onTestFinished(() => release.resolve());
        await entered.promise;
        expect(observations).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        monotonicMs = 35;
        release.resolve();
        await expect(policy).resolves.toMatchObject({ admittedAudience: ['session-a'] });
        expect(observations).toHaveLength(1);
        expect(observations[0]).toMatchObject({
            availability: 'available',
            phases: { readStoredMessageElapsedMs: 0, queueIdentityReadElapsedMs: 35, ownerElapsedMs: 35 }
        });
    });

    it('keeps session admission and return inside the enclosing owner duration', async () => {
        const observations: ALOutboundCapturedPolicyTiming.Observation[] = [];
        let monotonicMs = 0;
        const fixture = await createFixture(['session-a'], undefined, {
            readMonotonicMs: () => monotonicMs,
            readEpochMs: () => 10_000,
            record: (observation) => observations.push(observation)
        });
        const entering = Promise.withResolvers<void>();
        const enterSession = Promise.withResolvers<void>();
        const leaving = Promise.withResolvers<void>();
        const leaveSession = Promise.withResolvers<void>();
        const readWithin = fixture.backend.readWithin.bind(fixture.backend);
        vi.spyOn(fixture.backend, 'readWithin').mockImplementation(async (read) => {
            entering.resolve();
            await enterSession.promise;
            const policy = await readWithin(read);
            leaving.resolve();
            await leaveSession.promise;
            return policy;
        });
        const policy = fixture.store.readCapturedPolicy(fixture.message, fixture.entry);
        onTestFinished(() => {
            enterSession.resolve();
            leaveSession.resolve();
        });
        await entering.promise;
        monotonicMs = 7;
        enterSession.resolve();
        await leaving.promise;
        expect(observations).toEqual([]);
        monotonicMs = 19;
        leaveSession.resolve();
        await expect(policy).resolves.toMatchObject({ admittedAudience: ['session-a'] });
        expect(observations[0]).toMatchObject({
            availability: 'available',
            phases: { ownerEntryElapsedMs: 7, sessionReturnElapsedMs: 12, ownerElapsedMs: 19 }
        });
    });

    it('separates reference and canonical validation at the actual policy owner', async () => {
        const observations: ALOutboundCapturedPolicyTiming.Observation[] = [];
        let monotonicMs = 0;
        const fixture = await createFixture(['session-a'], undefined, {
            readMonotonicMs: () => monotonicMs,
            readEpochMs: () => 10_000,
            record: (observation) => observations.push(observation)
        });
        const entry = { ...fixture.entry };
        Object.defineProperties(entry, {
            typeId: {
                get: () => {
                    monotonicMs = Math.max(monotonicMs, 11);
                    return fixture.entry.typeId;
                }
            },
            resource: {
                get: () => {
                    monotonicMs = Math.max(monotonicMs, 29);
                    return fixture.entry.resource;
                }
            }
        });

        await expect(fixture.store.readCapturedPolicy(fixture.message, entry))
            .resolves.toMatchObject({ admittedAudience: ['session-a'] });
        expect(observations[0]).toMatchObject({
            availability: 'available',
            phases: {
                readStoredMessageElapsedMs: 0,
                referenceValidationElapsedMs: 11,
                queueIdentityReadElapsedMs: 0,
                canonicalValidationElapsedMs: 18,
                ownerElapsedMs: 29
            }
        });
    });

    it('reports missing and corrupt authority as unavailable without changing the original failure or later success', async () => {
        const observations: ALOutboundCapturedPolicyTiming.Observation[] = [];
        const fixture = await createFixture(['session-a'], undefined, {
            readMonotonicMs: () => 1,
            readEpochMs: () => 10_000,
            record: (observation) => observations.push(observation)
        });
        const key = toALOutboundSentMessageKey('server-namespace', fixture.message.id.msgId);
        const row = fixture.state.data.get(key)!;
        const reference = fixture.stored.reference;
        fixture.state.data.delete(key);
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        fixture.state.data.set(key, row);
        await expect(fixture.store.readCapturedPolicy({
            ...fixture.message,
            payload: { ...fixture.message.payload, resource: '{"value":2}' }
        }, fixture.entry)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        fixture.stored.reference = { ...fixture.stored.reference, identity: 'forged-identity' };
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        fixture.stored.reference = reference;
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .resolves.toMatchObject({ admittedAudience: ['session-a'] });
        expect(observations.map((observation) => [observation.sequence, observation.outcome, observation.availability]))
            .toEqual([[1, 'failed', 'unavailable'], [2, 'failed', 'unavailable'], [3, 'failed', 'unavailable'], [4, 'succeeded', 'available']]);
        expect(observations.slice(0, 3)).toEqual(expect.arrayContaining([
            expect.objectContaining({ reason: 'policy-failed' })
        ]));
    });

    it.each(['stored', 'identity'] as const)('preserves a failed %s read and allows the next invocation', async (readKind) => {
        const observations: ALOutboundCapturedPolicyTiming.Observation[] = [];
        const fixture = await createFixture(['session-a'], undefined, {
            readMonotonicMs: () => 1,
            readEpochMs: () => 10_000,
            record: (observation) => observations.push(observation)
        });
        const failure = new Error(`${readKind} read failed`);
        const spy = readKind === 'stored'
            ? vi.spyOn(fixture.backend, 'read').mockRejectedValueOnce(failure)
            : vi.spyOn(fixture.backend, 'readWork').mockRejectedValueOnce(failure);
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry)).rejects.toBe(failure);
        spy.mockRestore();
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .resolves.toMatchObject({ admittedAudience: ['session-a'] });
        expect(observations.map((observation) => [observation.outcome, observation.availability]))
            .toEqual([['failed', 'unavailable'], ['succeeded', 'available']]);
    });

    it('contains optional clock and sink faults without altering policy or original read errors', async () => {
        const observations: ALOutboundCapturedPolicyTiming.Observation[] = [];
        let clockFails = true;
        let sinkFails = false;
        const fixture = await createFixture(['session-a'], undefined, {
            readMonotonicMs: () => {
                if (clockFails) {
                    throw new Error('optional clock failed');
                }
                return 1;
            },
            readEpochMs: () => 10_000,
            record: (observation) => {
                if (sinkFails) {
                    throw new Error('optional sink failed');
                }
                observations.push(observation);
            }
        });
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .resolves.toMatchObject({ admittedAudience: ['session-a'] });
        expect(observations[0]).toMatchObject({ availability: 'unavailable', reason: 'invalid-clock' });
        clockFails = false;
        sinkFails = true;
        const failure = new Error('original read failure');
        const read = vi.spyOn(fixture.backend, 'read').mockRejectedValueOnce(failure);
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry)).rejects.toBe(failure);
        read.mockRestore();
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .resolves.toMatchObject({ admittedAudience: ['session-a'] });
        sinkFails = false;
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .resolves.toMatchObject({ admittedAudience: ['session-a'] });
        expect(observations).toHaveLength(2);
        expect(observations[1]).toMatchObject({ sequence: 4, availability: 'available' });
    });

    it('contains optional identity projection faults after the policy read', async () => {
        const observations: ALOutboundCapturedPolicyTiming.Observation[] = [];
        const fixture = await createFixture(['session-a'], undefined, {
            readMonotonicMs: () => 1,
            readEpochMs: () => 10_000,
            record: (observation) => observations.push(observation)
        });
        const entry = { ...fixture.entry };
        Object.defineProperty(entry, 'db', {
            get: () => {
                throw new Error('optional row identity projection failed');
            }
        });

        await expect(fixture.store.readCapturedPolicy(fixture.message, entry))
            .resolves.toMatchObject({ admittedAudience: ['session-a'] });
        expect(observations).toEqual([
            expect.objectContaining({
                outcome: 'succeeded',
                availability: 'unavailable',
                reason: 'projection-failed',
                key: undefined,
                msgId: undefined,
                reservationAttempt: undefined
            })
        ]);
    });

    it('translates one real owner invocation with bounded identity and process provenance', async () => {
        const events: RallarTimingEvent[] = [];
        const fixture = await createFixture(
            ['session-a'],
            undefined,
            createRallarALOutboundCapturedPolicyTiming({
                timing: (event) => events.push(event),
                serviceId: 'api-test',
                publisherId: 'publisher-test',
                processId: 42,
                processStartedAtEpochMs: 9_000,
                readMonotonicMs: () => 5,
                readEpochMs: () => 10_000
            })
        );
        await fixture.store.readCapturedPolicy(fixture.message, fixture.entry);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            component: 'alm-outbound-dequeue',
            operation: 'outbox-captured-policy-phases',
            serviceId: 'api-test',
            status: 'ok',
            details: {
                publisherId: 'publisher-test',
                processId: 42,
                processStartedAtEpochMs: 9_000,
                namespace: 'server-namespace',
                policyReadSequence: 1,
                ...fixture.entry.key,
                msgId: fixture.message.id.msgId,
                rowId: 'unavailable',
                reservationStartedAtEpochMs: 'unavailable',
                anchorEpochMs: 10_000,
                anchorMonotonicMs: 5,
                readStoredMessageElapsedMs: 0,
                referenceValidationElapsedMs: 0,
                queueIdentityReadElapsedMs: 0,
                canonicalValidationElapsedMs: 0,
                ownerElapsedMs: 0
            }
        });
        expect(JSON.stringify(events)).not.toContain('"value":1');
    });

    it('returns the captured set, including empty, and distinguishes a missing admission', async () => {
        const fixture = await createFixture(['session-a']);
        const captured = await fixture.store.readCapturedPolicy(fixture.message, fixture.entry);
        expect(captured).toMatchObject({ admittedAudience: ['session-a'] });
        expect(captured).not.toHaveProperty('recipientScope');

        const empty = await createFixture([]);
        expect(await empty.store.readCapturedPolicy(empty.message, empty.entry)).toMatchObject({ admittedAudience: [] });

        const absentPolicy = await createFixture(undefined);
        expect((await absentPolicy.store.readCapturedPolicy(absentPolicy.message, absentPolicy.entry)).admittedAudience).toBeUndefined();

        absentPolicy.state.data.clear();
        await expect(absentPolicy.store.readCapturedPolicy(absentPolicy.message, absentPolicy.entry))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('refuses a stored room row that also stores a recipient scope', async () => {
        const fixture = await createFixture(['session-a'], { applicationId: 'app', workspaceId: 'workspace' });
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects a matching message id with the wrong canonical key, scope, or expiry', async () => {
        const fixture = await createFixture(['session-a']);
        const reference = fixture.stored.reference;
        await expect(fixture.store.readCapturedPolicy({
            ...fixture.message,
            payload: { ...fixture.message.payload, resource: '{"value":2}' }
        }, fixture.entry)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        await expect(fixture.store.readCapturedPolicy(fixture.message, {
            ...fixture.entry,
            key: { ...fixture.entry.key, contextId: 'another-context' }
        })).rejects.toBeInstanceOf(ALAdmissionCorruptionError);

        fixture.stored.reference = { ...reference, scope: 'another-scope' };
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);

        fixture.stored.reference = { ...reference, identity: 'forged-identity' };
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);

        fixture.stored.reference = { ...reference, expiresAtMs: reference.expiresAtMs + 1 };
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });
});

async function createFixture(
    admittedAudience: readonly string[] | undefined,
    recipientScope?: StateScope,
    capturedPolicyTiming?: ALOutboundCapturedPolicyTiming.Port | ALOutboundCapturedPolicyTiming.Capability
): Promise<CapturedAudienceFixture> {
    const nowMs = Date.now();
    const scope = 'server-scope';
    const namespace = 'server-namespace';
    const message = newALBroadcastMessage(
        'server',
        newALRoute('room.topic', 'room-1', 'event-1'),
        'room',
        'room.topic',
        { value: 1 },
        { ttlMs: 60_000, groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' } }
    );
    const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant());
    const reference = toALOutboundMessageReference(scope, entry, message);
    const stored: CapturedAudienceStoredMessage = {
        msgId: message.id.msgId,
        reference,
        supersedenceKey: undefined,
        unicastPeerId: null,
        orderingTrackKey: null,
        orderingSeq: null,
        policy: captureALOutboundPolicy({
            msg: message,
            dropReasonCode: undefined,
            lane: 'durable',
            preparedMessages: [],
            admittedAudience,
            ...(recipientScope === undefined ? {} : { recipientScope })
        }),
        creationExpiry: captureALOutboundCreationExpiry(message)
    };
    const state = createInMemoryALAdmissionState();
    await state.workQueue.enqueue(toALOutboundIdentityEntry(reference, entry, stored.creationExpiry));
    const key = toALOutboundSentMessageKey(namespace, message.id.msgId);
    state.data.set(key, { key, value: stored, expireAtTimestamp: nowMs + 120_000 });
    const backend = new InMemoryAdmissionBackend(state, () => nowMs);
    const store = createALOutboundAdmissionStore({
        nowMs: () => nowMs,
        canonicalScope: scope,
        namespace,
        backend,
        capturedPolicyTiming: capturedPolicyTiming === undefined ? undefined : 'createOwner' in capturedPolicyTiming
            ? capturedPolicyTiming
            : { createOwner: (ownerNamespace) => new ALOutboundCapturedPolicyTiming(ownerNamespace, capturedPolicyTiming) },
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention(),
        decodePrepared: () => {
            throw new TypeError('Captured audience fixture has no prepared messages');
        }
    });
    return { store, backend, state, stored, message, entry };
}
