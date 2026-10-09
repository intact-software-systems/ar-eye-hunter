import { describe, expect, it } from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALQosInputProvider, ALQosMessageContext } from '@shared/al-contracts/al-policy.ts';
import {
    AL_VOLATILE_SESSION_LIMITS,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionQosProvider } from '@shared/alm/volatile-budget/to-al-volatile-session-qos-provider.ts';

const NOW_MS = 1_700_000_000_000;
const CONTEXT: ALQosMessageContext = { direction: 'outbound' };
const MESSAGE = newALUnicastMessage(
    'self',
    { topicId: 'chat', resourceId: 'planned', contextId: 'room' },
    'peer',
    'chat.message.v1',
    { text: 'planned' },
    { ttlMs: 30_000 }
);
const APPLICATION: ALQosInputProvider = {
    defaultsForMessage: () => ({ durability: { algo: 'local-outbox', opts: {} } }),
    capabilitiesForMessage: () => ({ supportedAck: ['none'] }),
    authorizationForMessage: () => ({ maxDurability: 'volatile' }),
    liveForMessage: () => ({ connectedNeighborCount: 3 })
};

function createFullBudget(): ALVolatileSessionBudget {
    const budget = new ALVolatileSessionBudget({ ...AL_VOLATILE_SESSION_LIMITS, maxAdmissions: 1, maxBytes: 1_000 });
    budget.record({ msgId: 'received', bytes: 10, deadlineAtMs: NOW_MS + 1_000, nowMs: NOW_MS, trackKey: undefined });
    return budget;
}

const ACK = newALAckControlMessage(
    { v: 3, msgId: 'ack-planned', senderId: 'self', ts: NOW_MS },
    {
        ackedMsgId: 'planned',
        fromPeerId: 'self',
        toPeerId: 'peer',
        originPeerId: 'peer',
        logicalRecipientPeerId: 'self',
        carrier: 'rtc',
        status: 'delivered',
        observedAtEpochMs: NOW_MS
    }
);

describe('the session QoS provider over the volatile budget (D78)', () => {
    it('answers the application\'s live fields while the session is under its bound', () => {
        const budget = new ALVolatileSessionBudget({ ...AL_VOLATILE_SESSION_LIMITS, maxAdmissions: 1, maxBytes: 1_000 });
        const provider = toALVolatileSessionQosProvider(APPLICATION, budget, () => NOW_MS);

        expect(provider.liveForMessage?.(MESSAGE, CONTEXT)).toEqual({ connectedNeighborCount: 3 });
    });

    it('adds overloaded at the bound and keeps the application\'s other live fields', () => {
        const provider = toALVolatileSessionQosProvider(
            APPLICATION,
            createFullBudget(),
            () => NOW_MS
        );

        expect(provider.liveForMessage?.(MESSAGE, CONTEXT)).toEqual({
            connectedNeighborCount: 3,
            overloaded: true
        });
    });

    it('states overloaded with no application provider, and nothing below the bound', () => {
        const budget = createFullBudget();
        let nowMs = NOW_MS;
        const provider = toALVolatileSessionQosProvider(undefined, budget, () => nowMs);

        expect(provider.liveForMessage?.(MESSAGE, CONTEXT)).toEqual({ overloaded: true });
        nowMs = NOW_MS + 1_000;
        expect(provider.liveForMessage?.(MESSAGE, CONTEXT)).toBeUndefined();
    });

    it('states no overload while arrivals alone hold the total, and overloaded once the own share is held too (D189)', () => {
        const budget = new ALVolatileSessionBudget({ ...AL_VOLATILE_SESSION_LIMITS, maxAdmissions: 2, maxBytes: 1_000 });
        const provider = toALVolatileSessionQosProvider(APPLICATION, budget, () => NOW_MS);
        for (const msgId of ['received-1', 'received-2']) {
            budget.record({ msgId, bytes: 10, deadlineAtMs: NOW_MS + 1_000, nowMs: NOW_MS, trackKey: undefined });
        }

        expect(provider.liveForMessage?.(MESSAGE, CONTEXT)).toEqual({ connectedNeighborCount: 3 });
        budget.tryAdmit({ msgId: 'sent', bytes: 10, deadlineAtMs: NOW_MS + 1_000, nowMs: NOW_MS, trackKey: undefined });
        expect(provider.liveForMessage?.(MESSAGE, CONTEXT)).toEqual({ connectedNeighborCount: 3, overloaded: true });
    });

    it('passes the application\'s defaults, capabilities and authorization through unchanged', () => {
        const provider = toALVolatileSessionQosProvider(
            APPLICATION,
            createFullBudget(),
            () => NOW_MS
        );

        expect(provider.defaultsForMessage?.(MESSAGE, CONTEXT)).toEqual({
            durability: { algo: 'local-outbox', opts: {} }
        });
        expect(provider.capabilitiesForMessage?.(MESSAGE, CONTEXT)).toEqual({
            supportedAck: ['none']
        });
        expect(provider.authorizationForMessage?.(MESSAGE, CONTEXT)).toEqual({
            maxDurability: 'volatile'
        });
    });

    it.each(
        [
            ['an inbound plan', MESSAGE, { direction: 'inbound' }],
            ['a relay forward of another session\'s message', MESSAGE, { direction: 'outbound', fromPeerId: 'peer' }],
            ['a control this session sends', ACK, { direction: 'outbound' }]
        ] as const
    )('states no overload for %s at the bound: only the session\'s own data originations read it', (_, msg, context) => {
        const provider = toALVolatileSessionQosProvider(
            APPLICATION,
            createFullBudget(),
            () => NOW_MS
        );

        expect(provider.liveForMessage?.(msg, context)).toEqual({ connectedNeighborCount: 3 });
    });
});
