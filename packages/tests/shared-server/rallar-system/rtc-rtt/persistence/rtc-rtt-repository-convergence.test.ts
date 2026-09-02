import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decodePersistedAppInboxEnqueue } from '@shared-server/rallar-system/app-inbox/app-inbox-command-decoding.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import { encodeJsonWireValue, hashMutationCommand } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { RtcRttAppInboxHandler } from '@shared-server/rallar-system/rtc-rtt/inbox/rtc-rtt-app-inbox-handler.ts';
import { computeRtcRttMutation } from '@shared-server/rallar-system/rtc-rtt/mutation/compute-rtc-rtt-mutation.ts';
import { readRtcRttMutation } from '@shared-server/rallar-system/rtc-rtt/mutation/read-rtc-rtt-mutation.ts';
import { toRtcRttTopologyOutboxId } from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-identifiers.ts';
import { validateRtcRttWriteCandidate } from '@shared-server/rallar-system/rtc-rtt/mutation/validate-rtc-rtt-write-candidate.ts';
import { RTC_RTT_MUTATION_RETENTION_MS } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-persistence-validation-primitives.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import {
    RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
    RTC_RTT_LATEST_NAMESPACE,
    RTC_RTT_RECEIPTS_NAMESPACE
} from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-runtime-namespaces.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAuthorityHarness, createResilience } from '../../group-state/inbox/group-state-inbox-test-runtime.ts';
import {
    createMutableRttWriteCandidate,
    createRtcRttInboxTestRuntime,
    createRttGroupSnapshot,
    createValidRttWriteCandidate,
    rttWriteCandidateCorruptions
} from './rtc-rtt-persistence-test-fixtures.ts';

const ACCEPTED_AT = 10_000;
const REQUEST = {
    rtt: {
        sessionIdFrom: 'alice-session',
        sessionIdTo: 'bob-session',
        rttMs: 1,
        createdAtEpochMs: ACCEPTED_AT,
        version: 1
    },
    alSenderId: 'alice-session',
    capturedAtEpochMs: ACCEPTED_AT
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ACCEPTED_AT);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('RTC RTT repository convergence', () => {
    it('admits one endpoint-cap contender and rejects the loser after explicit queue redelivery', async () => {
        const harness = await createAuthorityHarness(['alice', 'bob', 'carol']);
        harness.runtimeRepository.serializeTransactions = true;
        const groupAB = createRttGroupSnapshot('room-ab', ['alice-session', 'bob-session'], ACCEPTED_AT);
        const groupAC = createRttGroupSnapshot('room-ac', ['alice-session', 'carol-session'], ACCEPTED_AT);
        let readPolicyInputCount = 0;
        const readPolicyInputs = async () => {
            readPolicyInputCount += 1;
            return {
                candidateGroups: [groupAB, groupAC],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 1
            };
        };
        const first = createRtcRttInboxTestRuntime({ harness, nowEpochMs: Date.now, ttlMs: 60_000, readPolicyInputs });
        const second = createRtcRttInboxTestRuntime({ harness, nowEpochMs: Date.now, ttlMs: 60_000, readPolicyInputs });
        const bothRead = Promise.withResolvers<void>();
        let arrivals = 0;
        for (const repository of [first.repository, second.repository]) {
            const listMeasurements = repository.listMeasurementEntries.bind(repository);
            vi.spyOn(repository, 'listMeasurementEntries').mockImplementation(async () => {
                const measurements = await listMeasurements();
                arrivals += 1;
                if (arrivals === 2) {
                    bothRead.resolve();
                }
                await bothRead.promise;
                return measurements;
            });
        }
        const firstEntry = await first.service.enqueue(REQUEST);
        const secondEntry = await second.service.enqueue({
            ...REQUEST,
            rtt: { ...REQUEST.rtt, sessionIdTo: 'carol-session', rttMs: 2 }
        });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await Promise.all([
            first.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience()),
            second.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience())
        ]);

        const attempts = await Promise.all([harness.queue.getItem(firstEntry.key), harness.queue.getItem(secondEntry.key)]);
        expect(attempts.map((entry) => entry?.status).sort()).toEqual([EntityStatus.COMPLETED, EntityStatus.RETRY].sort());
        expect(attempts.map((entry) => entry?.dequeueAudit.attempts)).toEqual([1, 1]);
        expect(readPolicyInputCount).toBe(2);
        expect(await first.repository.listMeasurements()).toHaveLength(1);
        expect(await first.repository.listMutationReceiptEntries()).toHaveLength(1);
        expect(harness.database.outboxEntries.size).toBe(1);
        const loser = attempts.find((entry) => entry?.status === EntityStatus.RETRY)!;
        expect(await harness.results.findByKey(loser.key)).toBeUndefined();

        vi.setSystemTime(ACCEPTED_AT + 6);
        await first.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        expect(readPolicyInputCount).toBe(3);
        expect(await harness.queue.getItem(loser.key)).toMatchObject({ status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 2 } });
        const result = await harness.results.findByKey(loser.key);
        expect(JSON.parse(result!.resource)).toMatchObject({ accepted: false, updated: false, reason: 'over-degree' });
        expect(await first.repository.listMeasurements()).toHaveLength(1);
        expect(await first.repository.listMutationReceiptEntries()).toHaveLength(1);
        expect(harness.database.outboxEntries.size).toBe(1);
        expect(first.observations.length + second.observations.length).toBe(1);
    });

    it.each(rttWriteCandidateCorruptions)('rejects $label at the production candidate validator', ({ corrupt }) => {
        const candidate = createMutableRttWriteCandidate();
        expect(() => validateRtcRttWriteCandidate(candidate, 86_400_002)).not.toThrow();
        const malformed = corrupt(candidate);
        expect(() => Reflect.apply(validateRtcRttWriteCandidate, undefined, [malformed, 86_400_002])).toThrow(TypeError);
    });

    it.each(['group', 'session-from', 'session-to'] as const)(
        'rejects expired %s authority through AppInbox without RTT writes',
        async (expiredAuthority) => {
            const harness = await createAuthorityHarness(['alice', 'bob']);
            const base = createRttGroupSnapshot('room-expired', ['alice-session', 'bob-session'], ACCEPTED_AT);
            const group = expiredAuthority === 'group'
                ? { ...base, group: { ...base.group, expiresAtEpochMs: ACCEPTED_AT } }
                : {
                    ...base,
                    activeSessions: base.activeSessions.map((session) =>
                        session.sessionId === (expiredAuthority === 'session-from' ? 'alice-session' : 'bob-session')
                            ? { ...session, expiresAtEpochMs: ACCEPTED_AT }
                            : session
                    )
                };
            const runtime = createRtcRttInboxTestRuntime({
                harness,
                nowEpochMs: Date.now,
                ttlMs: 60_000,
                readPolicyInputs: async () => ({ candidateGroups: [group], overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1 })
            });
            const entry = await runtime.service.enqueue(REQUEST);

            await runtime.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

            const result = await harness.results.findByKey(entry.key);
            expect(JSON.parse(result!.resource)).toMatchObject({ accepted: false, updated: false, reason: 'no-shared-active-group' });
            expect(await harness.queue.getItem(entry.key)).toMatchObject({ status: EntityStatus.COMPLETED });
            for (const namespace of [RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE, RTC_RTT_LATEST_NAMESPACE, RTC_RTT_RECEIPTS_NAMESPACE]) {
                expect(await harness.runtimeRepository.findAllEntries(namespace)).toEqual([]);
            }
            expect(harness.database.outboxEntries.size).toBe(0);
            expect(runtime.observations).toEqual([]);
        }
    );

    it.each(['group-expiry', 'peer-expiry', 'session-connection'] as const)(
        'rereads %s after a real CAS conflict exits the first queue delivery',
        async (change) => {
            const harness = await createAuthorityHarness(['alice', 'bob']);
            const base = createRttGroupSnapshot('room-redelivery', ['alice-session', 'bob-session'], ACCEPTED_AT);
            let group = change === 'group-expiry'
                ? { ...base, group: { ...base.group, expiresAtEpochMs: ACCEPTED_AT + 6 } }
                : base;
            const readPolicyInputs = vi.fn(async () => ({
                candidateGroups: [group],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 1
            }));
            const runtime = createRtcRttInboxTestRuntime({ harness, nowEpochMs: Date.now, ttlMs: 100, readPolicyInputs });
            const facts = vi.spyOn(runtime.repository, 'readMutationFacts');
            const inserts = vi.spyOn(harness.runtimeRepository, 'insertIfAbsent');
            harness.runtimeRepository.beforeConditionalWrite = async (operation, namespace, key) => {
                if (operation !== 'insertIfAbsent' || namespace !== RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE) {
                    return;
                }
                harness.runtimeRepository.beforeConditionalWrite = undefined;
                await harness.runtimeRepository.upsert(
                    namespace,
                    key,
                    JSON.stringify({
                        endpointId: 'alice-session',
                        peers: [{ peerSessionId: 'carol-session', expiresAtEpochMs: ACCEPTED_AT + 5 }],
                        version: 1,
                        updatedAtEpochMs: ACCEPTED_AT
                    }),
                    ACCEPTED_AT + 5
                );
            };
            const entry = await runtime.service.enqueue(REQUEST);
            inserts.mockClear();
            vi.spyOn(console, 'error').mockImplementation(() => undefined);

            await runtime.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

            const endpointInsert = inserts.mock.calls.findIndex(([namespace]) => namespace === RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE);
            expect(endpointInsert).toBeGreaterThanOrEqual(0);
            await expect(inserts.mock.results[endpointInsert]!.value).resolves.toMatchObject({ status: 'conflict' });
            expect(readPolicyInputs).toHaveBeenCalledTimes(1);
            expect(facts).toHaveBeenCalledTimes(1);
            expect(await harness.queue.getItem(entry.key)).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 1 } });
            expect(await harness.results.findByKey(entry.key)).toBeUndefined();
            for (const namespace of [RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE, RTC_RTT_LATEST_NAMESPACE, RTC_RTT_RECEIPTS_NAMESPACE]) {
                expect(await harness.runtimeRepository.findAllEntries(namespace)).toEqual([]);
            }
            expect(harness.database.outboxEntries.size).toBe(0);
            expect(runtime.observations).toEqual([]);

            if (change === 'peer-expiry') {
                await expect(runtime.repository.commitEndpointAdmission(
                    {
                        endpointId: 'alice-session',
                        peers: [{ peerSessionId: 'carol-session', expiresAtEpochMs: ACCEPTED_AT + 5 }],
                        version: 1,
                        updatedAtEpochMs: ACCEPTED_AT
                    },
                    null,
                    ACCEPTED_AT + 5
                )).resolves.toMatchObject({ status: 'accepted' });
            }
            if (change === 'session-connection') {
                group = {
                    ...base,
                    activeSessions: base.activeSessions.map((session) => ({
                        ...session,
                        generationVersion: ACCEPTED_AT + 7,
                        connectedAtEpochMs: ACCEPTED_AT + 7,
                        lastHeartbeatAtEpochMs: ACCEPTED_AT + 7
                    }))
                };
            }
            vi.setSystemTime(ACCEPTED_AT + 6);

            await runtime.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

            expect(readPolicyInputs).toHaveBeenCalledTimes(2);
            expect(facts).toHaveBeenCalledTimes(2);
            expect(await harness.queue.getItem(entry.key)).toMatchObject({ status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 2 } });
            const result = await harness.results.findByKey(entry.key);
            if (change === 'peer-expiry') {
                expect(JSON.parse(result!.resource)).toMatchObject({ accepted: true, updated: true });
                expect(await runtime.repository.findMeasurementEntry('alice-session', 'bob-session')).toMatchObject({
                    value: REQUEST.rtt,
                    entry: { expireAtTimestamp: ACCEPTED_AT + 106 }
                });
                expect(await runtime.repository.findEndpointAdmissionEntry('alice-session')).toMatchObject({
                    value: {
                        peers: [{ peerSessionId: 'bob-session', expiresAtEpochMs: ACCEPTED_AT + 106 }],
                        updatedAtEpochMs: ACCEPTED_AT + 6
                    }
                });
                expect(await runtime.repository.listMutationReceiptEntries()).toMatchObject([{
                    value: { acceptedAtEpochMs: ACCEPTED_AT + 6, attemptCount: 2 }
                }]);
                expect(harness.database.outboxEntries.size).toBe(1);
                expect(runtime.observations).toEqual([REQUEST.rtt]);
            }
            else {
                expect(JSON.parse(result!.resource)).toMatchObject({ accepted: false, updated: false, reason: 'no-shared-active-group' });
                expect(await runtime.repository.listMeasurements()).toEqual([]);
                expect(await runtime.repository.listMutationReceiptEntries()).toEqual([]);
                expect(harness.database.outboxEntries.size).toBe(0);
                expect(runtime.observations).toEqual([]);
            }
        }
    );

    it.each((['duplicate', 'out-of-order'] as const).flatMap((defect) => (['direct', 'list', 'page'] as const).map((surface) => ({ defect, surface }))))(
        'rejects $defect affected group refs on receipt $surface reads',
        async ({ defect, surface }) => {
            const storage = new FakeRuntimeStateRepository();
            const repository = new RtcRttRepository(storage, { now: () => 2 });
            const original = createValidRttWriteCandidate().receipt;
            const refA = { ...original.affectedGroupRefs[0]!, groupId: 'room-a' };
            const refB = { ...refA, groupId: 'room-b' };
            const valid = {
                ...original,
                affectedGroupRefs: [refA, refB],
                outboxIds: [refA, refB].map((ref) => toRtcRttTopologyOutboxId(original.receiptId, ref, original.commandHash))
            };
            const expiry = original.acceptedAtEpochMs + RTC_RTT_MUTATION_RETENTION_MS;
            await storage.upsert(RTC_RTT_RECEIPTS_NAMESPACE, valid.receiptId, JSON.stringify(valid), expiry);
            const readReceipt = () =>
                surface === 'direct'
                    ? repository.findMutationReceiptEntry(valid.receiptId)
                    : surface === 'list'
                    ? repository.listMutationReceiptEntries()
                    : repository.listMutationReceiptEntriesPage({ limit: 10 });
            await expect(readReceipt()).resolves.toEqual(
                surface === 'direct'
                    ? expect.objectContaining({ value: valid })
                    : [expect.objectContaining({ value: valid })]
            );
            const corrupted = { ...valid, affectedGroupRefs: defect === 'duplicate' ? [refA, refA] : [refB, refA] };
            await storage.upsert(RTC_RTT_RECEIPTS_NAMESPACE, valid.receiptId, JSON.stringify(corrupted), expiry);

            await expect(readReceipt()).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
                message: expect.stringContaining('affected group refs are not canonical')
            });
            expect((await storage.findEntry(RTC_RTT_RECEIPTS_NAMESPACE, valid.receiptId))?.value).toBe(JSON.stringify(corrupted));
        }
    );

    it.each(['exact replay', 'divergent reuse'] as const)(
        'resolves %s from a physically retained receipt without domain clocks, reads or writes',
        async (variant) => {
            const storage = new FakeRuntimeStateRepository();
            const original = createValidRttWriteCandidate();
            const rtt = original.measurementGuard.value;
            const request = { rtt, alSenderId: rtt.sessionIdFrom };
            const commandHash = await hashMutationCommand(encodeJsonWireValue(request, 'RTT receipt fixture request'));
            const receipt = {
                ...original.receipt,
                commandHash,
                outboxIds: original.receipt.affectedGroupRefs.map((ref) => toRtcRttTopologyOutboxId(original.receipt.receiptId, ref, commandHash))
            };
            const expiry = receipt.acceptedAtEpochMs + RTC_RTT_MUTATION_RETENTION_MS;
            await storage.upsert(RTC_RTT_RECEIPTS_NAMESPACE, receipt.receiptId, JSON.stringify(receipt), expiry);
            vi.setSystemTime(expiry + 1);
            const clock = vi.fn(() => {
                throw new Error('Domain clock must not run on a raw receipt probe');
            });
            const repository = new RtcRttRepository(storage, { now: clock });
            const measurement = vi.spyOn(repository, 'readMeasurementEntry').mockRejectedValue(new Error('Unexpected measurement read'));
            const measurements = vi.spyOn(repository, 'listMeasurementEntries').mockRejectedValue(new Error('Unexpected measurement list'));
            const admission = vi.spyOn(repository, 'readEndpointAdmissionEntry').mockRejectedValue(new Error('Unexpected admission read'));
            const begin = vi.spyOn(storage, 'begin').mockRejectedValue(new Error('Unexpected transaction'));
            const insert = vi.spyOn(storage, 'insertIfAbsent').mockRejectedValue(new Error('Unexpected insert'));
            const update = vi.spyOn(storage, 'upsertIfRevision').mockRejectedValue(new Error('Unexpected update'));
            const cleanup = vi.spyOn(storage, 'deleteIfRevision').mockRejectedValue(new Error('Unexpected cleanup'));
            const incoming = variant === 'exact replay' ? request : { ...request, rtt: { ...rtt, rttMs: 2 } };

            const read = await readRtcRttMutation(repository, incoming);
            expect(read).toEqual({ receipt: expect.objectContaining({ value: receipt }) });
            const input = {
                command: { ...incoming, candidateGroups: null, overlaySnapshotsByGroupKey: null, degreeLimit: null },
                read,
                facts: {
                    commandHash: await hashMutationCommand(encodeJsonWireValue(incoming, 'RTT replay request')),
                    attemptCount: 2,
                    requestedAtEpochMs: null,
                    purgeAfterEpochMs: null
                }
            };
            if (variant === 'exact replay') {
                expect(computeRtcRttMutation(input)).toMatchObject({ outcome: 'replay', receipt });
            }
            else {
                expect(() => computeRtcRttMutation(input)).toThrowError(expect.objectContaining({ code: 'rtc-rtt-idempotency-conflict' }));
            }
            for (const effect of [clock, measurement, measurements, admission, begin, insert, update, cleanup]) {
                expect(effect).not.toHaveBeenCalled();
            }
        }
    );

    it.each(['exact replay', 'changed RTT'] as const)(
        'preserves retained RTT authority for %s after measurement and admission expiry',
        async (variant) => {
            const harness = await createAuthorityHarness(['alice', 'bob']);
            const group = createRttGroupSnapshot('room-retained', ['alice-session', 'bob-session'], ACCEPTED_AT);
            const original = createRtcRttInboxTestRuntime({
                harness,
                nowEpochMs: Date.now,
                ttlMs: 10,
                readPolicyInputs: async () => ({ candidateGroups: [group], overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1 })
            });
            const accepted = await original.service.enqueue(REQUEST);
            await original.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
            expect(JSON.parse((await harness.results.findByKey(accepted.key))!.resource)).toMatchObject({ accepted: true, updated: true });
            const receipts = await harness.runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE);

            vi.setSystemTime(ACCEPTED_AT + 12);
            expect(await original.repository.findMeasurement('alice-session', 'bob-session')).toBeUndefined();
            expect(await original.repository.findEndpointAdmissionEntry('alice-session')).toBeUndefined();
            const retained = await createAuthorityHarness(['alice', 'bob'], { runtimeRepository: harness.runtimeRepository });
            const policy = vi.fn(async () => {
                throw new Error('Replay must not refresh policy');
            });
            const replay = createRtcRttInboxTestRuntime({ harness: retained, nowEpochMs: Date.now, ttlMs: 10, readPolicyInputs: policy });
            const lifecycle = vi.spyOn(replay.repository, 'readMutationFacts').mockImplementation(() => {
                throw new Error('Replay must not capture domain time');
            });
            const measurement = vi.spyOn(replay.repository, 'readMeasurementEntry').mockRejectedValue(new Error('Replay must not read measurement'));
            const admission = vi.spyOn(replay.repository, 'readEndpointAdmissionEntry').mockRejectedValue(new Error('Replay must not read admission'));
            const measurements = vi.spyOn(replay.repository, 'listMeasurementEntries').mockRejectedValue(new Error('Replay must not list measurements'));
            const insert = vi.spyOn(retained.runtimeRepository, 'insertIfAbsent');
            const update = vi.spyOn(retained.runtimeRepository, 'upsertIfRevision');
            const cleanup = vi.spyOn(retained.runtimeRepository, 'deleteIfRevision');
            const request = variant === 'changed RTT'
                ? { ...REQUEST, rtt: { ...REQUEST.rtt, rttMs: 2 } }
                : REQUEST;
            const entry = await replay.service.enqueue(request);
            vi.spyOn(console, 'error').mockImplementation(() => undefined);

            await replay.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

            const result = await retained.results.findByKey(entry.key);
            expect(JSON.parse(result!.resource)).toMatchObject(
                variant === 'exact replay'
                    ? { accepted: true, updated: false, reason: 'accepted' }
                    : { type: 'app-inbox-failure', code: 'rtc-rtt-idempotency-conflict' }
            );
            expect(await retained.queue.getItem(entry.key)).toMatchObject({
                status: variant === 'exact replay' ? EntityStatus.COMPLETED : EntityStatus.FAILED,
                dequeueAudit: { attempts: 1 }
            });
            for (const effect of [policy, lifecycle, measurement, admission, measurements, insert, update, cleanup]) {
                expect(effect).not.toHaveBeenCalled();
            }
            expect(await retained.runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE)).toEqual(receipts);
            expect(retained.database.outboxEntries.size).toBe(0);
            expect(replay.observations).toEqual([]);
            expect(replay.recordedWrites).toEqual([]);
        }
    );

    it('surfaces an identical receipt contender conflict and preserves one committed AppInbox winner', async () => {
        const harness = await createAuthorityHarness(['alice', 'bob']);
        harness.runtimeRepository.serializeTransactions = true;
        const group = createRttGroupSnapshot('room-identical', ['alice-session', 'bob-session'], ACCEPTED_AT);
        const runtime = createRtcRttInboxTestRuntime({
            harness,
            nowEpochMs: Date.now,
            ttlMs: 60_000,
            readPolicyInputs: async () => ({ candidateGroups: [group], overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1 })
        });
        const queued = await runtime.service.enqueue(REQUEST);
        const reserved = await harness.queue.reserveEntries(InboxQueueReader.INBOX_DEQUEUE_TYPES, new Set([EntityStatus.NEW]), 1);
        const entry = [...reserved.values()][0]!;
        const context = { entry, message: decodePersistedALMessage(entry.resource), enqueue: decodePersistedAppInboxEnqueue(entry) };
        const handler = new RtcRttAppInboxHandler({
            groupStateService: harness.groupStateService,
            nowEpochMs: Date.now,
            transactionWriter: new AppInboxTransactionWriter({ database: harness.database }, { serviceId: 'identical-rtt-contenders', nowEpochMs: Date.now })
        });
        const bothRead = Promise.withResolvers<void>();
        const listMeasurements = runtime.repository.listMeasurementEntries.bind(runtime.repository);
        let arrivals = 0;
        vi.spyOn(runtime.repository, 'listMeasurementEntries').mockImplementation(async () => {
            const measurements = await listMeasurements();
            arrivals += 1;
            if (arrivals === 2) {
                bothRead.resolve();
            }
            await bothRead.promise;
            return measurements;
        });

        const results = await Promise.allSettled([
            handler.processMutation({ ...context }, runtime.dependencies),
            handler.processMutation({ ...context }, runtime.dependencies)
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toEqual([
            expect.objectContaining({ value: expect.objectContaining({ accepted: true, updated: true }) })
        ]);
        expect(results.filter((result) => result.status === 'rejected')).toEqual([
            expect.objectContaining({ reason: expect.any(RuntimeStateWriteConflictError) })
        ]);
        expect(arrivals).toBe(2);
        expect(await runtime.repository.listMutationReceiptEntries()).toHaveLength(1);
        expect(harness.database.outboxEntries.size).toBe(1);
        expect(runtime.observations).toEqual([REQUEST.rtt]);
        const committedResult = await harness.results.findByKey(queued.key);
        expect(JSON.parse(committedResult!.resource)).toMatchObject({ accepted: true, updated: true });
        expect(await harness.queue.getItem(queued.key)).toMatchObject({ status: EntityStatus.COMPLETED });

        await runtime.service.enqueue(REQUEST);
        await runtime.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        expect(await harness.results.findByKey(queued.key)).toEqual(committedResult);
        expect(arrivals).toBe(2);
        expect(runtime.observations).toEqual([REQUEST.rtt]);
        expect(harness.database.outboxEntries.size).toBe(1);
    });

    it.each(['direct', 'list', 'page'] as const)(
        'validates receipt identity before expiry on %s reads without cleanup',
        async (surface) => {
            const storage = new FakeRuntimeStateRepository();
            const repository = new RtcRttRepository(storage, { now: Date.now });
            const receipt = createValidRttWriteCandidate().receipt;
            const expiry = receipt.acceptedAtEpochMs + RTC_RTT_MUTATION_RETENTION_MS;
            const readReceipt = () =>
                surface === 'direct'
                    ? repository.findMutationReceiptEntry(receipt.receiptId)
                    : surface === 'list'
                    ? repository.listMutationReceiptEntries()
                    : repository.listMutationReceiptEntriesPage({ limit: 10 });
            await storage.upsert(RTC_RTT_RECEIPTS_NAMESPACE, receipt.receiptId, JSON.stringify(receipt), expiry);
            await expect(readReceipt()).resolves.toEqual(
                surface === 'direct'
                    ? expect.objectContaining({ value: receipt })
                    : [expect.objectContaining({ value: receipt })]
            );
            vi.setSystemTime(expiry + 1);
            await expect(readReceipt()).resolves.toEqual(surface === 'direct' ? undefined : []);
            const corrupted = { ...receipt, commandHash: 'sha256:' + 'A'.repeat(64) };
            await storage.upsert(RTC_RTT_RECEIPTS_NAMESPACE, receipt.receiptId, JSON.stringify(corrupted), expiry);

            await expect(readReceipt()).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
                message: expect.stringContaining('command hash is invalid')
            });
            expect((await storage.findEntry(RTC_RTT_RECEIPTS_NAMESPACE, receipt.receiptId))?.value).toBe(JSON.stringify(corrupted));
        }
    );
});
