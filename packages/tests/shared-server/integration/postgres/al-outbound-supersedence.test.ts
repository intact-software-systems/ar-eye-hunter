import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import {
    createALOutboundAdmissionStore,
    type ALOutboundAdmissionStore,
    type ALOutboundCommitBundle,
    type ALOutboundPlanner
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { toALOutboundCanonicalKey } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { computeALOutboundDispatch, type ALOutboundComputedDto } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';

import {
    createOutboundCanonicalEntry,
    createOutboundMessage,
    readOutboundTestAdmission
} from '../../../shared/alm/outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../../../shared/alm/outbound-test-payload.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type PostgresSql
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

/** One durable copy per message, the sender asking its own outbound for the track's next sequence. */
const MINTING_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    msg,
    dropReasonCode: undefined,
    lane: 'durable',
    preparedMessages: [{ text: msg.id.msgId }],
    mintsSequence: true
});

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres outbound shared supersedence', () => {
    postgresIt('rejects an earlier supersedence observation even when its commit starts after another connection commits', async () => {
        const [first, second] = await createStores();
        const older = createSupersedingMessage('sender-a', 1);
        const newer = createSupersedingMessage('sender-b', 2);
        const oldDecision = await readSupersedingBundle(first, older);
        const newDecision = await readSupersedingBundle(second, newer);

        expect(await second.commitBundle(newDecision)).toBe('committed');
        expect(await first.commitBundle(oldDecision)).toBe('conflict');

        expect(await first.readSentMessage(older.id.msgId)).toBeUndefined();
        expect((await first.readSentMessage(newer.id.msgId))?.msg).toEqual(newer);
        expect((await readSupersedingDecision(first, older)).verdict.kind).toBe('superseded');
    });
});

describe('Postgres outbound sequence minting', () => {
    postgresIt('mints the next sequence again when another connection committed the one it read', async () => {
        const [first, second] = await createStores();
        const loser = createMintRequest('mint-loser');
        const winner = createMintRequest('mint-winner');
        const losingBundle = await readOutboundTestAdmission({
            store: first,
            message: loser,
            creationNow: () => Temporal.Now.instant(),
            clock: { nowMs: () => Date.now() },
            planner: MINTING_PLANNER
        });
        const winningBundle = await readOutboundTestAdmission({
            store: second,
            message: winner,
            creationNow: () => Temporal.Now.instant(),
            clock: { nowMs: () => Date.now() },
            planner: MINTING_PLANNER
        });

        expect(await second.commitBundle(winningBundle)).toBe('committed');
        expect(await first.commitBundle(losingBundle)).toBe('conflict');
        expect(
            await first.commitBundle(
                await readOutboundTestAdmission({
                    store: first,
                    message: loser,
                    creationNow: () => Temporal.Now.instant(),
                    clock: { nowMs: () => Date.now() },
                    planner: MINTING_PLANNER
                })
            )
        ).toBe('committed');

        expect((await first.readSentMessage(winner.id.msgId))?.msg.ordering?.seq).toBe(1);
        expect((await second.readSentMessage(loser.id.msgId))?.msg.ordering?.seq).toBe(2);
    });
});

function createMintRequest(resourceId: string): ALMessage {
    return { ...createOutboundMessage(resourceId), ordering: { orderingKey: 'round', epoch: 1 } };
}

async function createStores(): Promise<readonly [ALOutboundAdmissionStore<OutboundTestPayload>, ALOutboundAdmissionStore<OutboundTestPayload>]> {
    const namespace = `outbound-supersedence-${crypto.randomUUID()}`;
    const canonicalKey = toALOutboundCanonicalKey(namespace, createOutboundMessage('any-message'));
    const first = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(async () => {
        try {
            await deleteNamespaceRows(first, namespace, canonicalKey);
        }
        finally {
            await first.end();
        }
    });
    const second = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(() => second.end());
    const configuration = {
        nowMs: Date.now,
        namespace,
        canonicalScope: namespace,
        decodePrepared: decodeOutboundTestPayload,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    };
    return [
        createALOutboundAdmissionStore({ ...configuration, backend: new PSqlAdmissionWorkBackend({ sql: first, namespace, nowMs: Date.now }) }),
        createALOutboundAdmissionStore({ ...configuration, backend: new PSqlAdmissionWorkBackend({ sql: second, namespace, nowMs: Date.now }) })
    ];
}

/**
 * Every row the two stores wrote: the admission rows under the namespace, the work rows of the
 * namespace (one topic and resource id, the effect id in the context) and the canonical and identity
 * rows of its scope (one resource id per scope, the message in the context).
 */
async function deleteNamespaceRows(sql: PostgresSql, namespace: string, canonicalKey: Key): Promise<void> {
    const work = toALOutboundWorkKey(namespace, 'any-effect-id');
    await sql`
        delete from resource_inbox
        where (ri_topic_id = ${work.topicId} and ri_resource_id = ${work.resourceId})
            or ri_resource_id = ${canonicalKey.resourceId}
    `;
    await sql`delete from runtime_state_store where store_namespace = ${namespace}`;
}

function createSupersedingMessage(senderId: string, sequence: number): ALMessage {
    const message = createOutboundMessage(`superseding-${sequence}`);
    return { ...message, id: { ...message.id, senderId }, ordering: { orderingKey: 'shared-topic', seq: sequence } };
}

async function readSupersedingDecision(
    store: ALOutboundAdmissionStore<OutboundTestPayload>,
    message: ALMessage
): Promise<ALOutboundComputedDto<OutboundTestPayload>> {
    const read = await store.readOutgoingMessage({
        msg: message,
        planner: (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'volatile',
            preparedMessages: [{ text: msg.id.msgId }],
            supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'shared-topic' }
        }),
        observedCanonicalEntry: undefined,
        intent: 'enqueue'
    });
    return computeALOutboundDispatch({
        read,
        outboxEntry: createOutboundCanonicalEntry(store, read.msg, Temporal.Now.instant()),
        dispatchAtMs: Date.now(),
        intent: 'enqueue',
        phase: 'immediate',
        options: {}
    });
}

async function readSupersedingBundle(
    store: ALOutboundAdmissionStore<OutboundTestPayload>,
    message: ALMessage
): Promise<ALOutboundCommitBundle<OutboundTestPayload>> {
    const decision = await readSupersedingDecision(store, message);
    if (decision.bundle === undefined) {
        throw new Error(`Expected an outbound admission, received ${decision.verdict.kind}`);
    }
    return decision.bundle;
}
