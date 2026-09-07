import { describe, expect, it, onTestFinished } from 'vitest';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore, type ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { computeALInboundPlanningObservations } from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import { computeALInboundAdmission } from '@shared/alm/inbound/compute-al-inbound-admission.ts';
import { readALInboundEffectFacts } from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';

import { createRuntimeStatePostgresSql, requirePostgresDatabaseUrl } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres inbound shared supersedence', () => {
    postgresIt('rejects an earlier observation even when its commit starts after another connection commits', async () => {
        const [first, second] = await createStores();
        const older = createMessage('sender-a', 1);
        const newer = createMessage('sender-b', 2);
        const oldDecision = await readDecision(first, older);
        const newDecision = await readDecision(second, newer);

        expect(await second.commitBundle(newDecision.bundle)).toBe('committed');
        expect(await first.commitBundle(oldDecision.bundle)).toBe('conflict');

        const refreshed = await readDecision(first, older);
        expect(refreshed.read.clientRecord).toBeUndefined();
        expect(refreshed.read.dedupExpiresAt).toBeUndefined();
        expect(refreshed.plan.supersedence.status).toBe('superseded');
        const effects = await first.claimReadyEffects({ workerId: 'observer', maxCount: 10, leaseMs: 10_000, nowMs: Date.now() });
        expect(effects.map((effect) =>
            effect.payload.kind === 'dispatch-local'
                ? decodePersistedALMessage(effect.payload.entry.resource).id.msgId
                : effect.payload.kind
        )).toEqual([newer.id.msgId]);
    });

    postgresIt('commits one concurrent decision and converges after the loser reads again', async () => {
        const [first, second] = await createStores();
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

async function createStores(): Promise<readonly [ALInboundAdmissionStore, ALInboundAdmissionStore]> {
    const namespace = `inbound-supersedence-${crypto.randomUUID()}`;
    const first = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(async () => {
        try {
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
    return [
        createALInboundAdmissionStore({ ...configuration, backend: new PSqlAdmissionWorkBackend(first, namespace) }),
        createALInboundAdmissionStore({ ...configuration, backend: new PSqlAdmissionWorkBackend(second, namespace) })
    ];
}

function createMessage(senderId: string, version: number): ALMessage {
    const message = newALUnicastMessage(
        senderId,
        { topicId: 'latest-values', resourceId: crypto.randomUUID(), contextId: 'receiver' },
        'receiver',
        'latest-value.v1',
        { version },
        { qos: { delivery: { algo: 'best-effort' }, ack: { algo: 'none' }, supersedence: { algo: 'latest-wins', opts: { supersedenceKey: 'shared-topic' } } } }
    );
    const createdTs = Date.now() - 1_000 + version;
    return { ...message, id: { ...message.id, ts: createdTs }, audit: { ...message.audit, createdTs } };
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
    const facts = readALInboundEffectFacts(message, nowMs, {
        selfPeerId: 'receiver',
        createInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox')
    });
    return { read, plan, bundle: computeALInboundAdmission({ read, plan, facts, canForward: false }) };
}
