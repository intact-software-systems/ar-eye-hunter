import { Temporal } from '@js-temporal/polyfill';
import { createHash } from 'node:crypto';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { toDomain } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import type { ClientStateService, ClientStateWritten } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { computeClientMutationOperation } from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-computation.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { computeClientSnapshotProvenance } from '@shared-server/rallar-system/client-state/persistence/client-snapshot-provenance.ts';
import {
    CLIENT_STATE_IDEMPOTENT_NAMESPACE,
    CLIENT_STATE_SESSIONS_NAMESPACE
} from '@shared-server/rallar-system/client-state/persistence/client-state-runtime-namespaces.ts';
import { clientStateSessionStorageKey } from '@shared-server/rallar-system/client-state/persistence/client-state-session-storage-key.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GROUPS_NAMESPACE, MEMBERS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { groupStateMemberStorageKey } from '@shared-server/rallar-system/group-state/persistence/membership/group-membership-storage-key.ts';
import {
    WS_OUTBOX_PROVENANCE_NAMESPACE,
    WsOutboxProvenanceReader
} from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { GroupMember } from '@shared/api/group-types.ts';
import { computeStateSnapshotPages, decodeStateSnapshotPage } from '@shared/api/state-snapshot-page.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import { createDefaultWsQueueBoxServerService, type WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { createTestGroup } from '../../../create-test-group.ts';
import { TestWebSocket } from '../../../shared/websocket/test-web-socket.ts';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { TestResourceInbox, TestResourceInboxResults } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createAppInboxTestDatabase, type AppInboxTestDatabase } from '../app-inbox/test-support/app-inbox-test-database.ts';
import {
    createAutoAuthorizingClientStateService,
    processAppInbox,
    requireRightSnapshot
} from './app-client-inbox-mutation-test-harness.ts';
import { connectCommand, emptyRead } from './client-mutation-compute-test-fixtures.ts';

vi.mock('@shared/api/state-snapshot-page.ts', async (importOriginal) => {
    const original = await importOriginal<typeof import('@shared/api/state-snapshot-page.ts')>();
    return { ...original, computeStateSnapshotPages: vi.fn(original.computeStateSnapshotPages) };
});

const SCOPE = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

interface SnapshotProducerFixture {
    readonly repository: FakeRuntimeStateRepository;
    readonly database: AppInboxTestDatabase;
    readonly service: AppClientInboxService;
    readonly reader: InboxQueueReader;
    readonly clientState: ClientStateService;
    readonly now: number;
    readonly state: {
        inTransaction: boolean;
        failCommit: boolean;
        proofSeenBeforeRollback: boolean;
        removeSessionBeforeWrite: boolean;
        removeMemberBeforeWrite: boolean;
    };
}

interface ForeignReceiverFixture {
    readonly service: WsQueueBoxServerService;
    readonly native: TestWebSocket;
    readonly engine: InboxOutboxEngine;
    readonly stores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    readonly reader: WsOutboxProvenanceReader;
    readonly socket: JsonWebSocketServer;
    readonly authentication: { scope: StateScope; now: number; };
}

describe('client snapshot producer provenance', () => {
    it('delivers the committed principal broadcast to a foreign co-group session', async () => {
        const producer = createProducer();
        await seedClient(producer, 'bob');
        requireRightSnapshot(await connectClient(producer, 'bob'));
        await seedClient(producer);
        requireRightSnapshot(await connectClient(producer));
        await seedCoGroup(producer);
        const before = new Set(producer.database.outboxEntries.keys());
        producer.state.removeMemberBeforeWrite = true;
        requireRightSnapshot(
            await processAppInbox(producer.service, producer.reader, {
                type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                senderId: 'alice',
                data: {
                    scope: SCOPE,
                    principalId: 'alice',
                    request: { username: 'alice', displayName: 'Updated', actorPrincipalId: 'alice', requestId: 'co-group-update' }
                }
            })
        );
        const entries = [...producer.database.outboxEntries].filter(([key]) => !before.has(key))
            .map(([, entry]) => toStoredEntry(entry))
            .filter((entry) => {
                const targets = decodePersistedALMessage(entry.resource).targets;
                return targets?.mode === 'broadcast' && targets.scope === 'principal';
            });
        expect(entries).toHaveLength(2);
        const foreign = createForeignReceiver(producer.repository, 'bob-session');
        for (const entry of entries) {
            expect(await foreign.reader.readProducerProvenance(decodePersistedALMessage(entry.resource), entry))
                .toEqual({ admittedAudience: ['alice-session', 'bob-session'], recipientScope: SCOPE });
            await foreign.stores.workQueue.enqueue(entry);
        }
        await foreign.engine.executeOnce();
        await expect.poll(() => foreign.native.sent.length).toBe(2);
    });

    it('delivers committed principal snapshot and event broadcasts to the own foreign session', async () => {
        const producer = createProducer();
        await seedClient(producer);
        const before = new Set(producer.database.outboxEntries.keys());
        requireRightSnapshot(await connectClient(producer));
        const entries = [...producer.database.outboxEntries].filter(([key]) => !before.has(key))
            .map(([, entry]) => toStoredEntry(entry)).filter((entry) => {
                const targets = decodePersistedALMessage(entry.resource).targets;
                return targets?.mode === 'broadcast' && targets.scope === 'principal';
            });
        expect(entries).toHaveLength(2);
        const foreign = createForeignReceiver(producer.repository);
        for (const entry of entries) {
            await foreign.stores.workQueue.enqueue(entry);
        }
        await foreign.engine.executeOnce();
        await expect.poll(() => foreign.native.sent.length).toBe(2);
    });

    it.each(['wrong-scope', 'late-session', 'expired-proof', 'replaced-session'] as const)(
        'prevents foreign principal broadcast delivery for %s',
        async (kind) => {
            const producer = createProducer();
            await seedClient(producer);
            const before = new Set(producer.database.outboxEntries.keys());
            requireRightSnapshot(await connectClient(producer));
            const entry = [...producer.database.outboxEntries].filter(([key]) => !before.has(key))
                .map(([, row]) => toStoredEntry(row))
                .find((row) => {
                    const targets = decodePersistedALMessage(row.resource).targets;
                    return targets?.mode === 'broadcast' && targets.scope === 'principal';
                });
            if (!entry) {
                throw new Error('Expected a principal state-sync broadcast');
            }
            const foreign = createForeignReceiver(producer.repository, kind === 'late-session' ? 'late-session' : 'alice-session');
            const replacement = new TestWebSocket('ws://replacement');
            replacement.open();
            if (kind === 'wrong-scope') {
                foreign.authentication.scope = { ...SCOPE, workspaceId: 'other' };
            }
            if (kind === 'expired-proof') {
                foreign.authentication.now = entry.audit.expiryTs.epochMilliseconds;
            }
            if (kind === 'replaced-session') {
                const encode = foreign.socket.encode.bind(foreign.socket);
                const spy = vi.spyOn(foreign.socket, 'encode').mockImplementation((message) => {
                    foreign.socket.addConnection(new ConnectionContext({ id: 'alice-session', socket: replacement }));
                    return encode(message);
                });
                onTestFinished(() => spy.mockRestore());
            }
            await foreign.stores.workQueue.enqueue(entry);
            await foreign.engine.executeOnce();
            await expect.poll(async () => (await foreign.stores.workQueue.getItem(entry.key))?.status)
                .toBe(
                    kind === 'expired-proof'
                        ? EntityStatus.NON_RETRYABLE
                        : kind === 'late-session'
                        ? EntityStatus.RETRY
                        : EntityStatus.COMPLETED
                );
            expect(foreign.native.sent).toEqual([]);
            expect(replacement.sent).toEqual([]);
        }
    );

    it('delivers the committed mutation snapshot to its frozen session on a foreign dequeue', async () => {
        const producer = createProducer();
        await seedClient(producer);
        const result = await connectClient(producer);
        expect(requireRightSnapshot(result).activeSessions.map((session) => session.sessionId)).toEqual(['alice-session']);
        const entries = [...producer.database.outboxEntries.values()].map(toStoredEntry).filter((entry) =>
            decodePersistedALMessage(entry.resource).targets?.mode === 'unicast'
        );
        expect(entries.length).toBeGreaterThan(0);
        const foreign = createForeignReceiver(producer.repository);
        for (const entry of entries) {
            await foreign.stores.workQueue.enqueue(entry);
        }
        await foreign.engine.executeOnce();
        await expect.poll(async () => (await foreign.stores.workQueue.getItem(entries[0]!.key))?.status).toBe(EntityStatus.COMPLETED);
        expect(foreign.native.sent).toHaveLength(entries.length);
    });

    it('computes hashes before transaction entry and rolls back proof, row, receipt and state together', async () => {
        const producer = createProducer();
        await seedClient(producer);
        const before = [...producer.database.outboxEntries.keys()];
        const proofsBefore = await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE);
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, bytes) => {
            if (producer.state.inTransaction) {
                throw new Error('Hashing entered the write transaction');
            }
            return digest(algorithm, bytes);
        });
        onTestFinished(() => spy.mockRestore());
        producer.state.failCommit = true;
        const result = await connectClient(producer);
        expect(result.left).toBeDefined();
        expect(producer.state.proofSeenBeforeRollback).toBe(true);
        expect([...producer.database.outboxEntries.keys()]).toEqual(before);
        expect(await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE)).toEqual(proofsBefore);
        expect((await producer.clientState.readSnapshot({ ...SCOPE, principalId: 'alice' }))?.activeSessions).toEqual([]);
    });

    it('captures an empty principal audience without active sessions and adds no proof or row on replay', async () => {
        const producer = createProducer();
        await seedClient(producer);
        const initialProofs = await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE);
        expect(initialProofs.length).toBeGreaterThan(0);
        expect(initialProofs.every((proof) => JSON.parse(proof.value).target.admittedAudience.length === 0)).toBe(true);
        const first = await connectClient(producer);
        const proofs = await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE);
        const rows = [...producer.database.outboxEntries.keys()];
        const replay = await connectClient(producer);
        expect(requireRightSnapshot(replay)).toEqual(requireRightSnapshot(first));
        expect(await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE)).toEqual(proofs);
        expect([...producer.database.outboxEntries.keys()]).toEqual(rows);
    });

    it('rolls back principal state, receipt, event and outbox on an exact proof-key collision', async () => {
        const producer = createProducer({ collideOnRequestId: 'colliding-profile' });
        await seedClient(producer);
        requireRightSnapshot(await connectClient(producer));
        const beforeSnapshot = await producer.clientState.readSnapshot({ ...SCOPE, principalId: 'alice' });
        const beforeReceipts = await producer.repository.findAllEntries(CLIENT_STATE_IDEMPOTENT_NAMESPACE);
        const beforeEvents = await producer.clientState.listEvents({ ...SCOPE, principalId: 'alice' });
        const beforeRows = [...producer.database.outboxEntries];
        const beforeProofs = await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE);
        const result = await upsertAliceProfile(producer, 'colliding-profile', 'Collision candidate');
        expect(result.left).toMatchObject({ code: 'resource-inbox-invariant-corruption' });
        expect(await producer.clientState.readSnapshot({ ...SCOPE, principalId: 'alice' })).toEqual(beforeSnapshot);
        expect(await producer.repository.findAllEntries(CLIENT_STATE_IDEMPOTENT_NAMESPACE)).toEqual(beforeReceipts);
        expect(await producer.clientState.listEvents({ ...SCOPE, principalId: 'alice' })).toEqual(beforeEvents);
        expect([...producer.database.outboxEntries]).toEqual(beforeRows);
        const proofs = await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE);
        expect(proofs).toHaveLength(beforeProofs.length + 1);
        expect(proofs.filter((proof) => !beforeProofs.some((before) => before.key === proof.key))).toMatchObject([
            { value: 'occupied-proof' }
        ]);
    });

    it('adds no principal proof or outbox row for a semantic no-op with a new request', async () => {
        const producer = createProducer();
        await seedClient(producer);
        requireRightSnapshot(await connectClient(producer));
        requireRightSnapshot(await upsertAliceProfile(producer, 'profile-change', 'Alice'));
        const beforeSnapshot = await producer.clientState.readSnapshot({ ...SCOPE, principalId: 'alice' });
        const beforeRows = [...producer.database.outboxEntries];
        const beforeProofs = await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE);
        const result = await upsertAliceProfile(producer, 'profile-no-op', 'Alice');
        expect(requireRightSnapshot(result)).toEqual(beforeSnapshot);
        expect([...producer.database.outboxEntries]).toEqual(beforeRows);
        expect(await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE)).toEqual(beforeProofs);
    });

    it('samples the injected read clock once for a principal audience', async () => {
        const clock = { now: Date.now(), calls: 0 };
        const producer = createProducer({
            nowMs: () => {
                clock.calls += 1;
                return clock.now;
            }
        });
        await seedClient(producer);
        requireRightSnapshot(await connectClient(producer));
        clock.calls = 0;
        clock.now = producer.now + 60_001;
        const before = await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE);
        requireRightSnapshot(await upsertAliceProfile(producer, 'clock-profile', 'Clock controlled'));
        const added = (await producer.repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE))
            .filter((proof) => !before.some((prior) => prior.key === proof.key));
        const principalProofs = added.map((proof) => JSON.parse(proof.value))
            .filter((proof) => proof.target.kind === 'scoped-principal-broadcast');
        expect(clock.calls).toBe(1);
        expect(principalProofs).toHaveLength(2);
        expect(principalProofs.map((proof) => proof.target.admittedAudience)).toEqual([[], []]);
    });

    it.each(['wrong-scope', 'replaced-session', 'expired-proof'] as const)('prevents foreign delivery for %s', async (kind) => {
        const producer = createProducer();
        await seedClient(producer);
        requireRightSnapshot(await connectClient(producer));
        const entry = readUnicastEntries(producer)[0]!;
        const foreign = createForeignReceiver(producer.repository);
        const replacement = new TestWebSocket('ws://replacement');
        replacement.open();
        if (kind === 'wrong-scope') {
            foreign.authentication.scope = { ...SCOPE, workspaceId: 'other' };
        }
        if (kind === 'expired-proof') {
            foreign.authentication.now = entry.audit.expiryTs.epochMilliseconds;
        }
        if (kind === 'replaced-session') {
            const encode = foreign.socket.encode.bind(foreign.socket);
            const spy = vi.spyOn(foreign.socket, 'encode').mockImplementation((message) => {
                foreign.socket.addConnection(new ConnectionContext({ id: 'alice-session', socket: replacement }));
                return encode(message);
            });
            onTestFinished(() => spy.mockRestore());
        }
        await foreign.stores.workQueue.enqueue(entry);
        await foreign.engine.executeOnce();
        await expect.poll(async () => (await foreign.stores.workQueue.getItem(entry.key))?.status)
            .toBe(kind === 'expired-proof' ? EntityStatus.NON_RETRYABLE : EntityStatus.COMPLETED);
        expect(foreign.native.sent).toEqual([]);
        expect(replacement.sent).toEqual([]);
    });

    it('binds every snapshot page and never admits a late local session', async () => {
        const producer = createProducer();
        await seedClient(producer);
        requireRightSnapshot(await connectClient(producer));
        const before = new Set(producer.database.outboxEntries.keys());
        requireRightSnapshot(
            await processAppInbox(producer.service, producer.reader, {
                type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                senderId: 'alice',
                data: {
                    scope: SCOPE,
                    principalId: 'alice',
                    request: { username: 'alice', actorPrincipalId: 'alice', metadata: { description: 'x'.repeat(52_000) }, requestId: 'large-profile' }
                }
            })
        );
        const pages = [...producer.database.outboxEntries].filter(([key]) => !before.has(key))
            .map(([, entry]) => toStoredEntry(entry)).filter((entry) => decodePersistedALMessage(entry.resource).targets?.mode === 'unicast');
        expect(pages.length).toBeGreaterThan(1);
        const foreign = createForeignReceiver(producer.repository);
        const late = new TestWebSocket('ws://late');
        late.open();
        foreign.socket.addConnection(new ConnectionContext({ id: 'late-session', socket: late }));
        const indexes: number[] = [];
        for (const entry of pages) {
            const message = decodePersistedALMessage(entry.resource);
            const page = decodeStateSnapshotPage(message, SCOPE).fold((issue) => {
                throw new Error(issue.message);
            }, (value) => value);
            indexes.push(page.index);
            expect(page.count).toBe(pages.length);
            expect(await foreign.reader.readProducerProvenance(message, entry)).toEqual({ admittedAudience: ['alice-session'], recipientScope: SCOPE });
            await foreign.stores.workQueue.enqueue(entry);
        }
        expect(indexes).toEqual(Array.from({ length: pages.length }, (_, index) => index));
        await foreign.engine.executeOnce();
        await expect.poll(() => foreign.native.sent.length).toBe(pages.length);
        expect(late.sent).toEqual([]);
    });

    it('keeps the accepted audience when durable session state changes between read and write', async () => {
        const producer = createProducer();
        await seedClient(producer);
        requireRightSnapshot(await connectClient(producer));
        const before = new Set(producer.database.outboxEntries.keys());
        producer.state.removeSessionBeforeWrite = true;
        const result = await processAppInbox(producer.service, producer.reader, {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                principalId: 'alice',
                request: { username: 'alice', displayName: 'Frozen observation', actorPrincipalId: 'alice', requestId: 'interval-profile' }
            }
        });
        expect(requireRightSnapshot(result).activeSessions.map((session) => session.sessionId)).toEqual(['alice-session']);
        expect((await producer.clientState.readSnapshot({ ...SCOPE, principalId: 'alice' }))?.activeSessions).toEqual([]);
        const entry = [...producer.database.outboxEntries].filter(([key]) => !before.has(key)).map(([, row]) => toStoredEntry(row))
            .find((row) => decodePersistedALMessage(row.resource).targets?.mode === 'unicast')!;
        const foreign = createForeignReceiver(producer.repository);
        await foreign.stores.workQueue.enqueue(entry);
        await foreign.engine.executeOnce();
        await expect.poll(() => foreign.native.sent.length).toBe(1);
    });
});

describe('client snapshot provenance computation', () => {
    it('builds the snapshot pages once per operation compute and keeps the sidecar bytes', () => {
        const command = connectCommand();
        const completionEntry: ResourceEntry = {
            key: { topicId: 'app-inbox.client-state', resourceId: 'provenance-golden', contextId: 'client-state' },
            resource: '{}',
            typeId: EnqueuedType.APP_INBOX,
            audit: {
                date: Temporal.PlainTime.from('00:00:01'),
                createdBy: 'client-service',
                createdTs: Temporal.PlainDateTime.from('1970-01-01T00:00:01'),
                expiryTs: NEVER_EXPIRE_TS
            },
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 1 }
        };
        vi.mocked(computeStateSnapshotPages).mockClear();

        const computed = computeClientMutationOperation({
            command,
            read: emptyRead(command),
            completionFacts: { entry: completionEntry, completedAtEpochMs: 8_000 },
            lifecycle: undefined
        });

        // Every page build re-serializes the whole principal snapshot; one build per compute is the cost contract.
        expect(computeStateSnapshotPages).toHaveBeenCalledTimes(1);
        const sidecarWrites = computed.outcome === 'completed' ? computed.sidecarWrites : [];
        expect(sidecarWrites.map((write) => ({
            resourceId: write.queueKey.resourceId,
            targetKind: JSON.parse(write.value).target.kind,
            digest: JSON.parse(write.value).digest
        }))).toEqual([
            {
                resourceId: '--snapshot-page--------3l3eod9ywabyf',
                targetKind: 'scoped-principal-broadcast',
                digest: '944b7465e368453a3792d4935a1766428c985c72a33cf03720a47a8f59471bec'
            },
            {
                resourceId: '--snapshot-page--------24zodg2oyjb9e',
                targetKind: 'scoped-unicast',
                digest: 'd63bc9e0f1fffe4f06360c0a103ee7bfe4c457b1ab8044ddac761e7f2b570a26'
            },
            {
                resourceId: 'connect-1-principal-st-2r959tktplfmi',
                targetKind: 'scoped-principal-broadcast',
                digest: '62ce0a30664f70c5f7a92da4194dfae0827302125b008cb01cd518d11e586dd6'
            }
        ]);
        expect(createHash('sha256').update(JSON.stringify(sidecarWrites)).digest('hex'))
            .toBe('3e06f98302c30781e81e570bb06be9125dc5ca281e1dbac54bed3c0914c05e11');
    });
});

function readUnicastEntries(producer: SnapshotProducerFixture): ResourceEntry[] {
    return [...producer.database.outboxEntries.values()].map(toStoredEntry)
        .filter((entry) => decodePersistedALMessage(entry.resource).targets?.mode === 'unicast');
}

function toStoredEntry(entry: ResourceEntry): ResourceEntry {
    return toDomain({
        ri_row_id: 1n,
        ri_resource_id: entry.key.resourceId,
        ri_topic_id: entry.key.topicId,
        ri_resource: entry.resource,
        ri_type_id: entry.typeId,
        ri_status: entry.status,
        fk_ext_bank_id: entry.key.contextId,
        system_date: entry.audit.createdTs.toPlainDate().toString(),
        created_by: entry.audit.createdBy,
        created_ts: entry.audit.createdTs.toString(),
        expire_ts: entry.audit.expiryTs.toZonedDateTimeISO('UTC').toPlainDateTime().toString(),
        start_ts: null,
        end_ts: null,
        next_ts: null,
        ri_attempts: 0n
    });
}

function createProducer(options: { readonly collideOnRequestId?: string; readonly nowMs?: () => number; } = {}): SnapshotProducerFixture {
    const queue = new TestResourceInbox();
    const results = new TestResourceInboxResults();
    const reader = new InboxQueueReader(queue);
    const repository = new FakeRuntimeStateRepository();
    const state = {
        inTransaction: false,
        failCommit: false,
        proofSeenBeforeRollback: false,
        removeSessionBeforeWrite: false,
        removeMemberBeforeWrite: false
    };
    const database = createAppInboxTestDatabase(queue, results, {
        runtimeRepository: repository,
        withTransaction: async (write) => {
            await removeSnapshotAudienceBeforeWrite(repository, state);
            state.inTransaction = true;
            try {
                return await write();
            }
            finally {
                state.inTransaction = false;
            }
        },
        onStage: async (stage) => {
            if (state.failCommit && stage === 'transaction-commit-return') {
                state.failCommit = false;
                state.proofSeenBeforeRollback = (await repository.findAllEntries(WS_OUTBOX_PROVENANCE_NAMESPACE)).length > 0;
                throw new NonRetryableException('Injected commit failure');
            }
        }
    });
    const durable = createAutoAuthorizingClientStateService(repository, database, { nowMs: options.nowMs });
    const clientState: ClientStateService = options.collideOnRequestId
        ? {
            ...durable,
            read: async (command) => {
                const read = await durable.read(command);
                if (command.requestId === options.collideOnRequestId) {
                    const mutation = computeClientMutation({ command, read });
                    const [proof] = computeClientSnapshotProvenance(mutation);
                    if (!proof) {
                        throw new Error('Expected an exact principal proof collision candidate');
                    }
                    await repository.upsert(proof.namespace, proof.key, 'occupied-proof', Number.MAX_SAFE_INTEGER);
                }
                return read;
            }
        }
        : durable;
    const service = new AppClientInboxService({
        inboxQueueReader: reader,
        resourceInboxRepository: queue,
        resourceInboxResultsRepository: results,
        database,
        clientStateService: clientState
    }, { serviceId: 'producer-server' });
    return { repository, database, service, reader, state, clientState, now: Date.now() };
}

/** Changes durable membership after the accepted observation and before transaction entry. */
async function removeSnapshotAudienceBeforeWrite(
    repository: FakeRuntimeStateRepository,
    state: SnapshotProducerFixture['state']
): Promise<void> {
    if (state.removeSessionBeforeWrite) {
        await repository.deleteByKey(
            CLIENT_STATE_SESSIONS_NAMESPACE,
            clientStateSessionStorageKey({
                ...SCOPE,
                principalId: 'alice',
                clientInstanceId: 'browser',
                sessionId: 'alice-session'
            })
        );
    }
    if (state.removeMemberBeforeWrite) {
        await repository.deleteByKey(
            MEMBERS_NAMESPACE,
            groupStateMemberStorageKey({ ...SCOPE, groupId: 'shared-room', principalId: 'bob' })
        );
    }
}

function upsertAliceProfile(
    producer: SnapshotProducerFixture,
    requestId: string,
    displayName: string
): Promise<Either<AppInboxFailure, ClientStateWritten>> {
    return processAppInbox(producer.service, producer.reader, {
        type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
        senderId: 'alice',
        data: {
            scope: SCOPE,
            principalId: 'alice',
            request: { username: 'alice', displayName, actorPrincipalId: 'alice', requestId }
        }
    });
}

async function seedClient(producer: SnapshotProducerFixture, principalId = 'alice'): Promise<void> {
    const principal = await processAppInbox(producer.service, producer.reader, {
        type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
        senderId: principalId,
        data: { scope: SCOPE, principalId, request: { username: principalId, actorPrincipalId: principalId, requestId: `principal-${principalId}` } }
    });
    requireRightSnapshot(principal);
    const instance = await processAppInbox(producer.service, producer.reader, {
        type: AppInboxType.CLIENT_INSTANCE_UPSERT,
        senderId: principalId,
        data: {
            scope: SCOPE,
            principalId,
            clientInstanceId: 'browser',
            request: { platform: 'web', capabilities: ['ws'], actorPrincipalId: principalId, requestId: `instance-${principalId}` }
        }
    });
    requireRightSnapshot(instance);
}

async function seedCoGroup(producer: SnapshotProducerFixture): Promise<void> {
    const ref = { ...SCOPE, groupId: 'shared-room' };
    const audit = {
        atEpochMs: producer.now,
        actor: { kind: 'principal' as const, principalId: 'alice' },
        reason: null,
        traceId: null,
        requestId: null
    };
    const group = createTestGroup({
        ...ref,
        ownerPrincipalId: 'alice',
        activeMemberCount: 2,
        rosterVersion: 2,
        snapshotVersion: 2,
        created: audit,
        updated: audit
    });
    await producer.repository.upsert(
        GROUPS_NAMESPACE,
        groupStateGroupStorageKey(ref),
        JSON.stringify(group),
        Number.MAX_SAFE_INTEGER
    );
    for (const [principalId, role] of [['alice', 'owner'], ['bob', 'member']] as const) {
        const member: GroupMember = {
            ...ref,
            principalId,
            role,
            status: 'active',
            joined: audit,
            updated: audit,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null
        };
        await producer.repository.upsert(
            MEMBERS_NAMESPACE,
            groupStateMemberStorageKey({ ...ref, principalId }),
            JSON.stringify(member),
            Number.MAX_SAFE_INTEGER
        );
    }
}

function connectClient(producer: SnapshotProducerFixture, principalId = 'alice'): Promise<Either<AppInboxFailure, ClientStateWritten>> {
    const now = producer.now;
    const sessionId = `${principalId}-session`;
    return processAppInbox(producer.service, producer.reader, {
        type: AppInboxType.CLIENT_SESSION_CONNECT,
        senderId: principalId,
        data: {
            scope: SCOPE,
            principalId,
            clientInstanceId: 'browser',
            sessionId,
            request: {
                generationId: 'generation',
                presenceState: 'online',
                actorPrincipalId: principalId,
                actorSessionId: sessionId,
                connectedAtEpochMs: now,
                lastHeartbeatAtEpochMs: now,
                expiresAtEpochMs: now + 60_000,
                requestId: `connect-${principalId}`
            }
        }
    });
}

function createForeignReceiver(repository: FakeRuntimeStateRepository, sessionId = 'alice-session'): ForeignReceiverFixture {
    const authentication = { scope: SCOPE, now: Date.now() };
    const reader = new WsOutboxProvenanceReader({ repository, nowMs: () => authentication.now });
    const socket = new JsonWebSocketServer();
    const native = new TestWebSocket('ws://foreign');
    native.open();
    socket.addConnection(new ConnectionContext({ id: sessionId, socket: native }));
    const engine = new InboxOutboxEngine();
    const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    const service = createDefaultWsQueueBoxServerService({
        inboundVolatileStores: undefined,
        name: 'foreign-server',
        socket,
        outbox: stores.workQueue,
        outboundStores: stores,
        queueEngine: engine,
        readProducerProvenance: (message, entry) => reader.readProducerProvenance(message, entry),
        readAuthenticatedConnectionScope: () => ({ scope: authentication.scope, expiresAtEpochMs: Date.now() + 60_000 })
    });
    const fixture = { service, native, engine, stores, reader, socket, authentication };
    onTestFinished(() => closeForeignReceiver(fixture));
    return fixture;
}

/** The foreign test fixture owns its service and its separately supplied engine. */
async function closeForeignReceiver(fixture: Pick<ForeignReceiverFixture, 'service' | 'engine'>): Promise<void> {
    const outcomes = await Promise.allSettled([fixture.service.dispose(), fixture.engine.stop()]);
    const failures = outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [toError(outcome.reason)] : []);
    const primary = failures[0];
    if (!primary) {
        return;
    }
    if (failures.length > 1) {
        try {
            console.error('Foreign snapshot receiver secondary cleanup failed', new AggregateError(failures.slice(1), 'Foreign receiver cleanup'));
        }
        catch {
            // Reporting cannot replace the original disposal failure.
        }
    }
    throw primary;
}

describe('foreign snapshot receiver cleanup ownership', () => {
    it('joins real engine work when service disposal rejects', async () => {
        const fixture = createForeignReceiver(new FakeRuntimeStateRepository());
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let available = true;
        let workCompleted = false;
        fixture.engine.includeTask('held-foreign-work', {
            name: 'held-foreign-work',
            maxConcurrency: () => 1,
            isWork: () => available,
            runnable: async () => {
                available = false;
                entered.resolve();
                await release.promise;
                workCompleted = true;
            },
            ongoingTasks: []
        });
        await fixture.engine.executeOnce();
        await entered.promise;
        const serviceFailure = new Error('foreign service disposal failed');
        const failedService = Promise.withResolvers<void>();
        const disposal = vi.spyOn(fixture.service, 'dispose').mockImplementation(async () => {
            failedService.resolve();
            throw serviceFailure;
        });
        let cleanupCompleted = false;
        const closing = closeForeignReceiver(fixture).then(
            () => {
                cleanupCompleted = true;
                return undefined;
            },
            (failure) => {
                cleanupCompleted = true;
                return toError(failure);
            }
        );
        try {
            await failedService.promise;
            await Promise.resolve();
            expect(cleanupCompleted, 'Foreign cleanup returned while its actual engine work remained held').toBe(false);
        }
        finally {
            release.resolve();
            disposal.mockRestore();
            await Promise.allSettled([closing, fixture.service.dispose(), fixture.engine.stop()]);
        }
        expect(workCompleted).toBe(true);
        expect(await closing).toBe(serviceFailure);
    });

    it('preserves the exact primary disposal Error when secondary cleanup reporting throws', async () => {
        const fixture = createForeignReceiver(new FakeRuntimeStateRepository());
        const primary = new Error('primary foreign disposal');
        const secondary = new Error('secondary foreign engine');
        const dispose = vi.spyOn(fixture.service, 'dispose').mockRejectedValue(primary);
        const stop = vi.spyOn(fixture.engine, 'stop').mockRejectedValue(secondary);
        const reported: AggregateError[] = [];
        const report = vi.spyOn(console, 'error').mockImplementation((_message, failure) => {
            if (failure instanceof AggregateError) {
                reported.push(failure);
            }
            throw new Error('foreign reporting sink');
        });
        try {
            await expect(closeForeignReceiver(fixture)).rejects.toBe(primary);
            expect(reported).toHaveLength(1);
            expect(reported[0]?.errors).toHaveLength(1);
            expect(reported[0]?.errors[0]).toBe(secondary);
        }
        finally {
            dispose.mockRestore();
            stop.mockRestore();
            report.mockRestore();
            await Promise.allSettled([fixture.service.dispose(), fixture.engine.stop()]);
        }
    });

    it('propagates the exact independently owned engine Error after successful service disposal', async () => {
        const fixture = createForeignReceiver(new FakeRuntimeStateRepository());
        const failure = new Error('foreign engine completion');
        const stop = vi.spyOn(fixture.engine, 'stop').mockRejectedValue(failure);
        try {
            await expect(closeForeignReceiver(fixture)).rejects.toBe(failure);
        }
        finally {
            stop.mockRestore();
            await fixture.engine.stop();
        }
    });
});
