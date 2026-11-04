import { describe, expect, it } from 'vitest';

import { validateGroupPresenceMutationRequest } from '@shared-server/rallar-system/group-state/mutation/command-validation/group-mutation-request-validation.ts';
import type { GroupPresenceSummaryComputedWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-effects.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { resolvePublicationKey } from '@shared/api/group-presence/resolve-publication-key.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import { validateGroupStateDeltaEnvelope, type GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupEvent, GroupPresencePublicationKey } from '@shared/api/group-types.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { readOrCreatePublicationCrypto } from '@shared/signature/read-or-create-publication-crypto.ts';

import {
    RFC_7517_PRIVATE_D,
    RFC_7517_PUBLICATION_KEY,
    ROTATED_PUBLICATION_KEY
} from '../../../../shared/api/group-presence/group-presence-publication-key-fixtures.ts';
import { InMemoryPublicationKeyStore } from '../../../../shared/signature/publication-key-store-fixtures.ts';
import { GroupBarrierRepository } from '../group-barrier-repository.ts';
import type { GroupStateTestService } from '../group-state-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import {
    convergeSummaryForTest,
    createMaintenance,
    createService,
    readSummaryWork,
    requireSnapshot,
    toSummaryExpansion
} from './group-presence-test-runtime.ts';

const BASE_EPOCH_MS = Date.now();
const LEASE_MS = 60_000;

describe('the publication key on the presence row', () => {
    it('stores the key a connect names and exposes it on the snapshot', async () => {
        const scenario = await createConnectedScenario('key-connect', RFC_7517_PUBLICATION_KEY);

        expect((await readStoredSession(scenario)).publicationKey).toEqual(RFC_7517_PUBLICATION_KEY);
        await converge(scenario, 'key-connect-converge');
        expect(resolvePublicationKey(await requireSnapshot(scenario.runtime, scenario.groupId), BOB_SESSION, BASE_EPOCH_MS))
            .toEqual(RFC_7517_PUBLICATION_KEY);
    });

    it('stores null for a page without SubtleCrypto', async () => {
        const scenario = await createConnectedScenario('key-connect-null', null);

        expect((await readStoredSession(scenario)).publicationKey).toBeNull();
        await converge(scenario, 'key-connect-null-converge');
        expect(resolvePublicationKey(await requireSnapshot(scenario.runtime, scenario.groupId), BOB_SESSION, BASE_EPOCH_MS))
            .toBeNull();
    });

    it('writes a heartbeat key change and expands it into the summary and the delta', async () => {
        const scenario = await createConnectedScenario('key-rotate', RFC_7517_PUBLICATION_KEY);
        await converge(scenario, 'key-rotate-converge');

        const receipt = await heartbeat(scenario, ROTATED_PUBLICATION_KEY, 1);

        expect(receipt.outboxIds).toHaveLength(1);
        expect((await readStoredSession(scenario)).publicationKey).toEqual(ROTATED_PUBLICATION_KEY);
        const envelope = toDeltaEnvelope(await computeHeartbeatSummaryWork(scenario));
        expect(envelope.sessions.map((session) => session.publicationKey)).toEqual([ROTATED_PUBLICATION_KEY]);
        await converge(scenario, 'key-rotate-heartbeat-converge');
        expect(resolvePublicationKey(await requireSnapshot(scenario.runtime, scenario.groupId), BOB_SESSION, BASE_EPOCH_MS))
            .toEqual(ROTATED_PUBLICATION_KEY);
    });

    it('bumps presenceRevision and fans the delta out for a key-only heartbeat, but queues no topology replan', async () => {
        const scenario = await createConnectedScenario('key-only-replan', RFC_7517_PUBLICATION_KEY);
        await converge(scenario, 'key-only-replan-converge');
        const converged = (await requireSnapshot(scenario.runtime, scenario.groupId)).causalRevision;

        await heartbeat(scenario, ROTATED_PUBLICATION_KEY, 1);
        const computed = await computeHeartbeatSummaryWork(scenario);

        expect(computed.summary.summary.causalRevision).toEqual({
            groupRevision: converged.groupRevision,
            presenceRevision: converged.presenceRevision + 1
        });
        expect(toDeltaEnvelope(computed).sessions.map((session) => session.publicationKey)).toEqual([
            ROTATED_PUBLICATION_KEY
        ]);
        expect(computed.topologyReplan).toEqual({ decision: 'no-topology-change' });
    });

    it('renews the lease without summary work when the heartbeat names the same key', async () => {
        const scenario = await createConnectedScenario('key-same', RFC_7517_PUBLICATION_KEY);
        await converge(scenario, 'key-same-converge');

        const receipt = await heartbeat(scenario, RFC_7517_PUBLICATION_KEY, 1);

        expect(receipt.outboxIds).toEqual([]);
        expect((await readStoredSession(scenario)).publicationKey).toEqual(RFC_7517_PUBLICATION_KEY);
    });

    it('renews the lease without summary work when a second page of the session heartbeats with the stored key', async () => {
        const store = new InMemoryPublicationKeyStore();
        const firstPage = await readSessionPublicationKey(store);
        const scenario = await createConnectedScenario('key-second-page', firstPage);
        await converge(scenario, 'key-second-page-converge');

        const receipt = await heartbeat(scenario, await readSessionPublicationKey(store), 1);

        expect(firstPage).not.toBeNull();
        expect(receipt.outboxIds).toEqual([]);
    });

    it('takes whatever the latest heartbeat said, including null', async () => {
        const scenario = await createConnectedScenario('key-to-null', RFC_7517_PUBLICATION_KEY);
        await converge(scenario, 'key-to-null-converge');

        const receipt = await heartbeat(scenario, null, 1);

        expect(receipt.outboxIds).toHaveLength(1);
        expect((await readStoredSession(scenario)).publicationKey).toBeNull();
        await converge(scenario, 'key-to-null-heartbeat-converge');
        expect(resolvePublicationKey(await requireSnapshot(scenario.runtime, scenario.groupId), BOB_SESSION, BASE_EPOCH_MS))
            .toBeNull();
    });

    it.each(
        [
            ['disconnect', (scenario: ConnectedScenario) =>
                scenario.service.disconnectPresenceSession(
                    SCOPE,
                    scenario.groupId,
                    BOB_SESSION,
                    { generationId: BOB_GENERATION, actorPrincipalId: 'bob', requestId: `disconnect-${scenario.groupId}` }
                )],
            ['cleanup', (scenario: ConnectedScenario) =>
                createMaintenance(scenario.runtime, BASE_EPOCH_MS + 2).disconnectPresenceSessionsBySessionId(
                    BOB_SESSION,
                    BASE_EPOCH_MS + 2
                )],
            ['expiry', (scenario: ConnectedScenario) =>
                createMaintenance(scenario.runtime, BASE_EPOCH_MS + LEASE_MS + 1).expireExpiredPresenceSessions(
                    BASE_EPOCH_MS + LEASE_MS + 1
                )],
            ['leave', (scenario: ConnectedScenario) =>
                scenario.service.upsertMember(SCOPE, scenario.groupId, 'bob', {
                    status: 'left',
                    actorPrincipalId: 'bob',
                    requestId: `leave-${scenario.groupId}`
                })],
            ['removal', (scenario: ConnectedScenario) =>
                scenario.service.removeGroupMember(SCOPE, scenario.groupId, 'bob', {
                    actorPrincipalId: 'alice',
                    requestId: `remove-${scenario.groupId}`
                })],
            ['ban', (scenario: ConnectedScenario) =>
                scenario.service.banGroupMember(SCOPE, scenario.groupId, 'bob', {
                    actorPrincipalId: 'alice',
                    requestId: `ban-${scenario.groupId}`
                })]
        ] as const
    )('drops the key with the session on %s', async (label, end) => {
        const scenario = await createConnectedScenario(`key-${label}`, RFC_7517_PUBLICATION_KEY);
        await converge(scenario, `key-${label}-converge`);
        expect(resolvePublicationKey(await requireSnapshot(scenario.runtime, scenario.groupId), BOB_SESSION, BASE_EPOCH_MS))
            .toEqual(RFC_7517_PUBLICATION_KEY);

        await end(scenario);
        await converge(scenario, `key-${label}-end-converge`, BASE_EPOCH_MS + LEASE_MS + 2);

        const snapshot = await requireSnapshot(scenario.runtime, scenario.groupId);
        expect(snapshot.activeSessions.map((session) => session.sessionId)).not.toContain(BOB_SESSION);
        expect(resolvePublicationKey(snapshot, BOB_SESSION, BASE_EPOCH_MS)).toBeNull();
    });
});

describe('a presence body without a well-formed publication key', () => {
    const connect = {
        requestId: 'connect-key-request',
        actorPrincipalId: 'bob',
        actorSessionId: BOB_SESSION,
        principalId: 'bob',
        generationId: BOB_GENERATION,
        connectionGenerationId: 'bob-ws-generation'
    };
    const privateKey = {
        ...RFC_7517_PUBLICATION_KEY,
        publicJwk: { ...RFC_7517_PUBLICATION_KEY.publicJwk, d: RFC_7517_PRIVATE_D }
    };

    it('is refused at the request boundary as the missing connection generation is', () => {
        const { connectionGenerationId: _omitted, ...withoutConnection } = connect;
        expect(toMessages('connectPresence', { ...withoutConnection, publicationKey: null })).toEqual([
            'Group connectPresence connectionGenerationId must be a non-empty string'
        ]);
        expect(toMessages('connectPresence', connect)).toEqual([
            'Group connectPresence publicationKey is invalid: $: publicationKey is required.'
        ]);
        expect(toMessages('connectPresence', { ...connect, publicationKey: privateKey })[0])
            .toMatch(/^Group connectPresence publicationKey is invalid: \$\.publicJwk\.d/);
        expect(toMessages('heartbeatPresence', { generationId: BOB_GENERATION })).toEqual([
            'Group heartbeatPresence publicationKey is invalid: $: publicationKey is required.'
        ]);
        expect(toMessages('connectPresence', { ...connect, publicationKey: RFC_7517_PUBLICATION_KEY })).toEqual([]);
        expect(toMessages('heartbeatPresence', { generationId: BOB_GENERATION, publicationKey: null })).toEqual([]);
    });

    it('is refused by the AppInbox command as the missing connection generation is', async () => {
        const scenario = await createConnectedScenario('key-refused', null);
        const { connectionGenerationId: _omitted, ...withoutConnection } = connect;
        const refusals = await Promise.allSettled([
            scenario.service.connectPresenceSession(SCOPE, scenario.groupId, BOB_SESSION, {
                ...withoutConnection,
                publicationKey: null
            }),
            scenario.service.connectPresenceSession(SCOPE, scenario.groupId, BOB_SESSION, connect),
            scenario.service.connectPresenceSession(SCOPE, scenario.groupId, BOB_SESSION, {
                ...connect,
                publicationKey: privateKey
            }),
            scenario.service.heartbeatPresenceSession(SCOPE, scenario.groupId, BOB_SESSION, {
                generationId: BOB_GENERATION,
                actorPrincipalId: 'bob',
                requestId: 'heartbeat-without-key'
            })
        ]);

        expect(refusals.map((refusal) => refusal.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
        for (const refusal of refusals) {
            expect(refusal.status === 'rejected' && refusal.reason).toBeInstanceOf(NonRetryableException);
        }
        expect(refusals.map((refusal) => refusal.status === 'rejected' && String(refusal.reason.message)).slice(1))
            .toEqual([
                'Group presence publication key is invalid: $: publicationKey is required.',
                expect.stringMatching(/^Group presence publication key is invalid: \$\.publicJwk\.d/),
                'Group presence publication key is invalid: $: publicationKey is required.'
            ]);
    });
});

const BOB_SESSION = 'bob-session';
const BOB_GENERATION = 'bob-generation';

interface ConnectedScenario {
    readonly runtime: GroupBarrierRepository;
    readonly service: GroupStateTestService;
    readonly groupId: string;
}

async function createConnectedScenario(
    groupId: string,
    publicationKey: GroupPresencePublicationKey | null
): Promise<ConnectedScenario> {
    const runtime = new GroupBarrierRepository();
    const service = createService({ runtimeRepository: runtime, nowEpochMs: BASE_EPOCH_MS, attemptCount: 1, injectedRandomId: undefined, timing: undefined });
    await service.createGroup(SCOPE, {
        groupId,
        displayName: groupId,
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'alice',
        requestId: `seed-${groupId}`
    });
    await service.upsertMember(SCOPE, groupId, 'bob', {
        status: 'active',
        actorPrincipalId: 'alice',
        requestId: `activate-${groupId}-bob`
    });
    await service.connectPresenceSession(SCOPE, groupId, BOB_SESSION, {
        principalId: 'bob',
        generationId: BOB_GENERATION,
        connectionGenerationId: 'bob-ws-generation',
        publicationKey,
        actorPrincipalId: 'bob',
        expiresAtEpochMs: BASE_EPOCH_MS + LEASE_MS,
        requestId: `connect-${groupId}-bob`
    });
    return { runtime, service, groupId };
}

async function heartbeat(
    scenario: ConnectedScenario,
    publicationKey: GroupPresencePublicationKey | null,
    afterMs: number
) {
    return await createService({
        runtimeRepository: scenario.runtime,
        nowEpochMs: BASE_EPOCH_MS + afterMs,
        attemptCount: 1,
        injectedRandomId: undefined,
        timing: undefined
    }).heartbeatPresenceSessionReceipt(
        SCOPE,
        scenario.groupId,
        BOB_SESSION,
        {
            generationId: BOB_GENERATION,
            publicationKey,
            actorPrincipalId: 'bob',
            lastHeartbeatAtEpochMs: BASE_EPOCH_MS + afterMs,
            requestId: `heartbeat-${scenario.groupId}-${afterMs}`
        }
    );
}

async function readStoredSession(scenario: ConnectedScenario) {
    const session = await createTestGroupStateRepository(scenario.runtime).findPresenceSession({
        ...groupRef(scenario.groupId),
        sessionId: BOB_SESSION
    });
    if (session === undefined) {
        throw new Error(`Missing presence session row: ${scenario.groupId}`);
    }
    return session;
}

async function converge(scenario: ConnectedScenario, commandId: string, nowEpochMs = BASE_EPOCH_MS + 1_000) {
    await convergeSummaryForTest({
        work: createSummaryWork(scenario.runtime, nowEpochMs),
        runtime: scenario.runtime,
        ref: groupRef(scenario.groupId),
        commandId,
        nowEpochMs
    });
}

async function computeHeartbeatSummaryWork(scenario: ConnectedScenario): Promise<GroupPresenceSummaryComputedWork> {
    const ref = groupRef(scenario.groupId);
    const event = (await createTestGroupStateRepository(scenario.runtime).listEvents(ref)).findLast(
        (candidate: GroupEvent) => candidate.eventType === 'session-heartbeat'
    );
    if (event === undefined) {
        throw new Error(`Missing session-heartbeat event: ${scenario.groupId}`);
    }
    const command: GroupPresenceSummaryWorkData = {
        effectKind: 'group-presence-summary',
        aggregateRef: ref,
        commandId: `${scenario.groupId}-heartbeat-delta`,
        createdAtEpochMs: event.occurredAtEpochMs,
        expireAtEpochMs: 253_402_300_799_999,
        acceptedCausalRevision: event.causalRevision,
        event
    };
    const work = createSummaryWork(scenario.runtime, BASE_EPOCH_MS + 1_000);
    const read = await readSummaryWork(work, command, BASE_EPOCH_MS + 1_000);
    return work.compute(toSummaryExpansion(command, read));
}

function toDeltaEnvelope(computed: GroupPresenceSummaryComputedWork): GroupStateDeltaEnvelope {
    const entry = computed.downstreamOutboxWrites[0]?.entry;
    if (entry === undefined) {
        throw new Error('Expected emitted group state event row');
    }
    return decodeGroupStateDeltaEnvelope(JSON.parse(decodePersistedALMessage(entry.resource).payload.resource));
}

function decodeGroupStateDeltaEnvelope(value: unknown): GroupStateDeltaEnvelope {
    validateGroupStateDeltaEnvelope(value);
    return value;
}

function createSummaryWork(runtime: GroupBarrierRepository, nowEpochMs: number): GroupPresenceSummaryWork {
    return new GroupPresenceSummaryWork({
        outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
        recomputeDebounceMs: 0,
        recomputeMaxWaitMs: 0,
        runtimeRepository: runtime,
        now: () => nowEpochMs,
        serviceId: 'summary-worker',
        senderPeerId: 'ws-server'
    });
}

/** The key a page of the session registers: the session's stored pair, read or created through the shared store. */
async function readSessionPublicationKey(store: InMemoryPublicationKeyStore): Promise<GroupPresencePublicationKey | null> {
    return toGroupPresencePublicationKey(
        await readOrCreatePublicationCrypto({ subtle: globalThis.crypto.subtle, store, sessionId: BOB_SESSION })
    );
}

function toMessages(operation: 'connectPresence' | 'heartbeatPresence', request: object): readonly string[] {
    return validateGroupPresenceMutationRequest(operation, request).map((issue) => issue.message);
}
