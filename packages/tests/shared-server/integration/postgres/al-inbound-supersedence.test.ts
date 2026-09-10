import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import { createTestALInboundWorkPort } from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore, type ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { computeALInboundPlanningObservations } from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import { decodeALInboundWorkEntry, toALInboundWorkKey } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { computeALInboundAdmission } from '@shared/alm/inbound/admission/compute-al-inbound-admission.ts';
import { readALInboundEffectFacts } from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { createRuntimeStatePostgresSql, requirePostgresDatabaseUrl } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres inbound shared supersedence', () => {
    postgresIt('admits independent messages from the same sender across concurrent connections', async () => {
        const [firstStores, secondStores] = await createStores();
        const first = firstStores.admissionStore;
        const second = secondStores.admissionStore;
        const firstDecision = await readDecision(first, createMessage('same-sender', 1, 'first-topic'));
        const secondDecision = await readDecision(second, createMessage('same-sender', 2, 'second-topic'));

        expect(
            await Promise.all([
                first.commitBundle(firstDecision.bundle),
                second.commitBundle(secondDecision.bundle)
            ])
        ).toEqual(['committed', 'committed']);

        const effects = await claimWork(firstStores);
        expect(effects).toHaveLength(2);
    });

    postgresIt('admits one concurrent copy of the same message across independent connections', async () => {
        const [firstStores, secondStores] = await createStores();
        const first = firstStores.admissionStore;
        const second = secondStores.admissionStore;
        const message = createMessage('same-sender', 1);
        const firstDecision = await readDecision(first, message);
        const secondDecision = await readDecision(second, message);

        expect((await Promise.all([
            first.commitBundle(firstDecision.bundle),
            second.commitBundle(secondDecision.bundle)
        ])).sort()).toEqual(['committed', 'conflict']);

        const effects = await claimWork(firstStores);
        expect(effects).toHaveLength(1);
    });
    postgresIt('rejects an earlier observation even when its commit starts after another connection commits', async () => {
        const [firstStores, secondStores] = await createStores();
        const first = firstStores.admissionStore;
        const second = secondStores.admissionStore;
        const older = createMessage('sender-a', 1);
        const newer = createMessage('sender-b', 2);
        const oldDecision = await readDecision(first, older);
        const newDecision = await readDecision(second, newer);

        expect(await second.commitBundle(newDecision.bundle)).toBe('committed');
        expect(await first.commitBundle(oldDecision.bundle)).toBe('conflict');

        const refreshed = await readDecision(first, older);
        expect(refreshed.read.observations.messageOwner).toBeUndefined();
        expect(refreshed.read.dedupExpiresAt).toBeUndefined();
        expect(refreshed.plan.supersedence.status).toBe('superseded');
        const effects = await claimWork(firstStores);
        expect(effects.map((effect) =>
            effect.payload.kind === 'dispatch-local'
                ? effect.payload.message.msgId
                : effect.payload.kind
        )).toEqual([newer.id.msgId]);
    });

    postgresIt('commits one concurrent decision and converges after the loser reads again', async () => {
        const [firstStores, secondStores] = await createStores();
        const first = firstStores.admissionStore;
        const second = secondStores.admissionStore;
        const older = createMessage('sender-a', 1);
        const newer = createMessage('sender-b', 2);
        const oldDecision = await readDecision(first, older);
        const newDecision = await readDecision(second, newer);

        const results = await Promise.all([first.commitBundle(oldDecision.bundle), second.commitBundle(newDecision.bundle)]);

        expect(results.filter((result) => result === 'committed')).toHaveLength(1);
        expect(results.filter((result) => result === 'conflict')).toHaveLength(1);
        if (results[1] === 'conflict') {
            const retry = await readDecision(second, newer);
            expect(retry.plan.dropReason).toBeUndefined();
            expect(await second.commitBundle(retry.bundle)).toBe('committed');
        }
        const refreshed = await readDecision(first, older);
        expect(refreshed.read.supersedence.latest?.latestMsgId).toBe(newer.id.msgId);
        expect(refreshed.plan.supersedence.status).toBe('superseded');
    });
});

async function createStores(): Promise<readonly [ALInboundRuntimeStores, ALInboundRuntimeStores]> {
    const namespace = `inbound-supersedence-${crypto.randomUUID()}`;
    const queueContext = toALInboundWorkKey(namespace, '').contextId;
    const first = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(async () => {
        try {
            await first`delete from resource_inbox where fk_ext_bank_id = ${queueContext}`;
            await first`delete from runtime_state_store where store_namespace = ${namespace}`;
        }
        finally {
            await first.end();
        }
    });
    const second = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(() => second.end());
    const configuration = {
        namespace,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    };
    const firstBackend = new PSqlAdmissionWorkBackend(first, namespace);
    const secondBackend = new PSqlAdmissionWorkBackend(second, namespace);
    return [
        {
            admissionStore: createALInboundAdmissionStore({ ...configuration, backend: firstBackend }),
            workQueue: firstBackend.workQueue
        },
        {
            admissionStore: createALInboundAdmissionStore({ ...configuration, backend: secondBackend }),
            workQueue: secondBackend.workQueue
        }
    ];
}

function createMessage(senderId: string, version: number, supersedenceKey = 'shared-topic'): ALMessage {
    const message = newALUnicastMessage(
        senderId,
        { topicId: 'latest-values', resourceId: crypto.randomUUID(), contextId: 'receiver' },
        'receiver',
        'latest-value.v1',
        { version },
        { qos: { delivery: { algo: 'best-effort' }, ack: { algo: 'none' }, supersedence: { algo: 'latest-wins', opts: { supersedenceKey } } } }
    );
    const createdTs = Date.now() - 1_000 + version;
    return { ...message, id: { ...message.id, ts: createdTs }, audit: { ...message.audit, createdTs } };
}

/** The claim step of the worker over one page, so a concurrency test observes the rows the runtime would. */
async function claimWork(stores: ALInboundRuntimeStores) {
    const port = createTestALInboundWorkPort({ ...stores, nowMs: Date.now });
    const page = await port.readPage({ status: EntityStatus.NEW, maxToRead: 10, cursor: null });
    return (await port.claim({ maxCount: 10, observedEntries: page.entries }))
        .map((claim) => decodeALInboundWorkEntry(claim.entry, stores.admissionStore.namespace));
}

async function readDecision(store: ALInboundAdmissionStore, message: ALMessage) {
    const nowMs = Date.now();
    const context = { selfPeerId: 'receiver', fromPeerId: message.id.senderId, nowMs };
    const read = await store.readIncomingMessage({
        msg: message,
        source: { kind: 'ws-client', peerId: message.id.senderId },
        nowMs,
        prePlan: planALMessageHandling(message, context)
    });
    const plan = planALMessageHandling(message, { ...context, ...computeALInboundPlanningObservations(read) });
    const facts = readALInboundEffectFacts(nowMs, {
        selfPeerId: 'receiver',
        newControlId: crypto.randomUUID.bind(crypto),
        createInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox')
    });
    return { read, plan, bundle: computeALInboundAdmission({ read, plan, facts, canForward: false }) };
}
