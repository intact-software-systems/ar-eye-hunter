import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundPlanner } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { toALMessageWithAppliedSupersedence } from '@shared/alm/outbound/supersedence/to-al-message-with-applied-supersedence.ts';
import { Either } from '@shared/resilience/Either.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    OUTBOUND_TEST_SEND_PLANNER
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
    const runtime = createDefaultOutboundTestRuntime({
        stores: createDefaultOutboundTestStores(),
        planOutgoingMessage,
        signAdmittedMessage: async (msg) => {
            signed.push(msg);
            return Either.ofRight({ ...msg, proof: PROOF });
        },
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
    return { runtime, signed };
}
