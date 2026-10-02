import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createPSqlALInboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SELF_PEER_ID,
    INBOUND_TEST_SOURCE
} from '../../../shared/alm/inbound-runtime-test-fixture.ts';
import { createPSqlAdmissionTestStorage } from './create-p-sql-admission-test-storage.ts';

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
    vi.useRealTimers();
});

/** An acknowledged copy addressed to this peer as its one next hop, due twice the 60 s window after it was sent. */
function createRetriedCopy(msgId: string): ALMessage {
    const message = createInboundTestMessage({ msgId, acknowledged: true });
    return {
        ...message,
        constraints: { ...message.constraints, expiresAtMs: Date.now() + 120_000 },
        forwarding: { ...message.forwarding, nextHopPeerIds: [INBOUND_TEST_SELF_PEER_ID] }
    };
}

it('acknowledges a replay after the dedup window inside its deadline again without a second delivery over PostgreSQL', async () => {
    const { repository } = await createPSqlAdmissionTestStorage();
    const fixture = createInboundTestRuntime({
        stores: createPSqlALInboundRuntimeStores({
            repository,
            namespace: 'psql-dedup-retention',
            orderingTrackTtlMs: 60_000,
            supersedenceTrackTtlMs: 60_000,
            retention: undefined
        }),
        carrier: 'ws',
        effectWorkerId: 'al-inbound:psql-dedup-retention'
    });
    const startedAtMs = Date.now();
    const copy = createRetriedCopy('replayed-past-the-window');
    const readAckedMsgIds = () =>
        fixture.controlSends.flat().flatMap((msg) => {
            const control = parseALControlMessage(msg);
            return control?.type === 'ack' ? [control.payload.ackedMsgId] : [];
        });

    await fixture.runtime.ready();
    expect((await fixture.runtime.admitIncomingMessage(copy, INBOUND_TEST_SOURCE)).right).toEqual({
        kind: 'admitted'
    });
    await expect.poll(readAckedMsgIds).toEqual([copy.id.msgId]);

    vi.setSystemTime(startedAtMs + 61_000);
    const replay = await fixture.runtime.admitIncomingMessage(copy, INBOUND_TEST_SOURCE);

    // The replay's answer is read first, so the replay's own batch has settled before any verdict.
    await expect.poll(readAckedMsgIds).toEqual([copy.id.msgId, copy.id.msgId]);
    expect(replay.right).toEqual({ kind: 'duplicate' });
    expect(fixture.delivered).toEqual(['dispatched']);
});
