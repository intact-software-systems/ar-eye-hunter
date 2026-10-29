import {
    createInitialALDeliveryLifecycle,
    type ALDeliveryLifecycle,
    type ALDeliveryState
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { describe, expect, it } from 'vitest';
import { toCapabilityDelivery } from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/match/to-director-attempt-state.ts';

describe('toCapabilityDelivery', () => {
    it.each<ALDeliveryState>(['submitted', 'staged'])('reads %s as a pending delivery that keeps its evidence', (state) => {
        expect(toCapabilityDelivery(toLifecycleAt(state))).toEqual({ state: 'pending', evidence: state, reason: undefined });
    });
});

function toLifecycleAt(state: ALDeliveryState): ALDeliveryLifecycle {
    const opened = createInitialALDeliveryLifecycle({
        msgId: 'msg-capability-1',
        typeId: 'ar-eye-hunter.capability.v1',
        ackMode: 'none',
        receiptAlgo: 'none',
        expiresAtMs: undefined,
        submittedAtMs: 1_000
    });
    return { ...opened, state };
}
