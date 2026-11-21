import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundPlanner } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { toALMessageWithAppliedSupersedence } from '@shared/alm/outbound/supersedence/to-al-message-with-applied-supersedence.ts';
import { Either } from '@shared/resilience/Either.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    drainOutboundWorkDueNow,
    OUTBOUND_TEST_SEND_PLANNER,
    readOutboundTestAdmission,
    type OutboundTestStores
} from '../../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../../outbound-test-payload.ts';

const PROOF = { alg: 'ES256', keyId: 'k'.repeat(43), signature: 'Q'.repeat(86) } as const;
const DEFAULT_KEY = 'provider-default-key';

/**
 * A planner whose provider defaults every chat message to latest-wins under `DEFAULT_KEY`, as a carrier's planner
 * resolves its QoS defaults: a requested supersedence names its own key.
 */
const LATEST_WINS_BY_DEFAULT_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg, authority) => ({
    ...OUTBOUND_TEST_SEND_PLANNER(msg, authority),
    supersedenceTracking: {
        enabled: true,
        algo: 'latest-wins',
        key: msg.qos?.supersedence?.opts?.supersedenceKey ?? DEFAULT_KEY
    }
});

describe('a send whose latest-wins supersedence came from its provider\'s defaults', () => {
    it('leaves with that supersedence in its own qos request, in place before the admission signs it', async () => {
        const { runtime, signed } = createSigningRuntime(LATEST_WINS_BY_DEFAULT_PLANNER);

        const admitted = await runtime.enqueueIfAbsent(createOutboundMessage('defaulted'));

        const applied = { algo: 'latest-wins', opts: { supersedenceKey: DEFAULT_KEY } };
        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.qos?.supersedence).toEqual(applied);
        expect(admitted.message.proof).toEqual(PROOF);
        expect(signed.map((msg) => msg.qos?.supersedence)).toEqual([applied]);
    });

    it('leaves stamped when its first plan threw and the durable lane\'s re-plan admitted it', async () => {
        let plans = 0;
        const { runtime, signed } = createSigningRuntime((msg, authority) => {
            plans += 1;
            if (plans === 1) {
                throw new Error('The first plan fails');
            }
            return LATEST_WINS_BY_DEFAULT_PLANNER(msg, authority);
        });

        const admitted = await runtime.enqueueIfAbsent(createOutboundMessage('replanned'));

        const applied = { algo: 'latest-wins', opts: { supersedenceKey: DEFAULT_KEY } };
        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.qos?.supersedence).toEqual(applied);
        expect(signed.map((msg) => msg.qos?.supersedence)).toEqual([applied]);
    });

    it('compares the same request enqueued twice equal to its stamped admission, refusing nothing', async () => {
        const { runtime, signed } = createSigningRuntime(LATEST_WINS_BY_DEFAULT_PLANNER);
        const message = createOutboundMessage('twice');

        const first = await runtime.enqueueIfAbsent(message);
        const second = await runtime.enqueueIfAbsent(message);

        expect(first.verdict.kind, first.reason).toBe('admitted');
        expect(second.verdict.kind, second.reason).not.toBe('refused');
        expect(second.verdict.kind, second.reason).not.toBe('failed');
        expect(second.message).toEqual(first.message);
        expect(signed).toHaveLength(1);
    });

    it('keeps a supersedence the app requested as it asked for it', async () => {
        const { runtime } = createSigningRuntime((msg, authority) => ({
            ...LATEST_WINS_BY_DEFAULT_PLANNER(msg, authority),
            supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'resolved-elsewhere' }
        }));
        const requested = { algo: 'latest-wins', opts: { supersedenceKey: 'app-key' } } as const;
        const message = createOutboundMessage('requested');

        const admitted = await runtime.enqueueIfAbsent({ ...message, qos: { ...message.qos, supersedence: requested } });

        expect(admitted.message.qos?.supersedence).toEqual(requested);
    });

    it('adds nothing to a send that supersedes nothing', async () => {
        const { runtime, signed } = createSigningRuntime(OUTBOUND_TEST_SEND_PLANNER);
        const message = createOutboundMessage('plain');

        const admitted = await runtime.enqueueIfAbsent(message);

        expect(admitted.message.qos).toEqual(message.qos);
        expect(signed[0]?.qos).toEqual(message.qos);
    });
});

describe('a send that carries another\'s envelope under an explicit plan', () => {
    it('leaves unstamped though its plan tracks latest-wins: a relay or server queue box stamps nothing', async () => {
        const { runtime, stores, sent } = createSigningRuntime(OUTBOUND_TEST_SEND_PLANNER);
        const message = createOutboundMessage('relayed');

        const admitted = await runtime.enqueueIfAbsent(message, LATEST_WINS_BY_DEFAULT_PLANNER(message, undefined));
        await drainOutboundWorkDueNow(runtime, stores);

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.qos?.supersedence).toBeUndefined();
        expect(sent.map((msg) => msg.qos?.supersedence)).toEqual([undefined]);
    });
});

describe('a send whose first commit conflicted, retained and drained', () => {
    it('drains an own send stamped, as its first admission decided', async () => {
        const { runtime, stores, sent } = createSigningRuntime(LATEST_WINS_BY_DEFAULT_PLANNER);
        const message = createOutboundMessage('own-retained');

        const retained = await enqueueBehindCompetitor(stores, () => runtime.enqueueIfAbsent(message));
        await drainOutboundWorkDueNow(runtime, stores);

        expect(retained.verdict).toEqual({ kind: 'pending' });
        expect(sent.map((msg) => msg.qos?.supersedence)).toEqual([
            { algo: 'latest-wins', opts: { supersedenceKey: DEFAULT_KEY } }
        ]);
    });

    it('drains an explicit plan\'s send unstamped, as its first admission decided', async () => {
        const { runtime, stores, sent } = createSigningRuntime(OUTBOUND_TEST_SEND_PLANNER);
        const message = createOutboundMessage('relayed-retained');

        const retained = await enqueueBehindCompetitor(
            stores,
            () => runtime.enqueueIfAbsent(message, LATEST_WINS_BY_DEFAULT_PLANNER(message, undefined))
        );
        await drainOutboundWorkDueNow(runtime, stores);

        expect(retained.verdict).toEqual({ kind: 'pending' });
        expect(sent.map((msg) => msg.qos?.supersedence)).toEqual([undefined]);
    });
});

describe('the supersedence stamp on one send', () => {
    it('never rewrites a send that already carries a proof: a signed message keeps its signed fields', () => {
        const message = { ...createOutboundMessage('signed'), proof: PROOF };

        const stamped = toALMessageWithAppliedSupersedence(message, { enabled: true, algo: 'latest-wins', key: DEFAULT_KEY });

        expect(stamped).toBe(message);
    });

    it('stamps only a latest-wins supersedence', () => {
        const message = createOutboundMessage('not-latest-wins');

        const stamped = toALMessageWithAppliedSupersedence(message, { enabled: true, algo: 'none', key: DEFAULT_KEY });

        expect(stamped).toBe(message);
    });
});

function createSigningRuntime(planOutgoingMessage: ALOutboundPlanner<OutboundTestPayload>) {
    const signed: ALMessage[] = [];
    const sent: ALMessage[] = [];
    const stores = createDefaultOutboundTestStores();
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        planOutgoingMessage,
        signAdmittedMessage: async (msg) => {
            signed.push(msg);
            return Either.ofRight({ ...msg, proof: PROOF });
        },
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            sent.push(lifecycle.canonicalMessage);
            return { status: 'sent', submissionAttempted: true };
        }
    });
    return { runtime, stores, signed, sent };
}

/** A competing send of the same sender wins the version fence inside the message's first commit, so it retains. */
async function enqueueBehindCompetitor<T>(stores: OutboundTestStores, enqueue: () => Promise<T>): Promise<T> {
    const store = stores.admissionStore;
    const competitor = await readOutboundTestAdmission({
        store,
        message: createOutboundMessage('competitor'),
        creationNow: () => Temporal.Now.instant(),
        clock: { nowMs: Date.now }
    });
    const commitBundle = store.commitBundle.bind(store);
    const spy = vi.spyOn(store, 'commitBundle').mockImplementationOnce(async (bundle, observation) => {
        expect(await commitBundle(competitor)).toBe('committed');
        return await commitBundle(bundle, observation);
    });
    try {
        return await enqueue();
    }
    finally {
        spy.mockRestore();
    }
}
