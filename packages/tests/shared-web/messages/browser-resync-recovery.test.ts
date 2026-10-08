import { describe, expect, it, vi } from 'vitest';

import { BrowserChannelRecoveryOwners } from '@shared-web/browser/messages/browser-channel-recovery-owners.ts';
import { BrowserMessageInputValidator } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import { BrowserResyncRecovery } from '@shared-web/browser/messages/browser-resync-recovery.ts';
import { BrowserTypedMessageChannels } from '@shared-web/browser/messages/browser-typed-message-channels.ts';
import type { RallarChannelRecovery } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type {
    ALInboundResyncCursor,
    ALInboundResyncRequired
} from '@shared/alm/inbound/al-inbound-resync-required.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { AL_VOLATILE_SESSION_MAX_AGE_MS } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import { createBrowserMessageSenderFixture } from './browser-message-sender-fixture.ts';

const CHAT_ROUTE = { topicId: 'app.chat', typeId: 'chat.message.v1' };

interface ResyncMessageInput {
    readonly typeId: string;
    readonly seq: number;
    readonly epoch?: number;
}

/** A message whose ordering is stated, so the cursor reads it without asserting. */
type OrderedResyncMessage = ALMessage & Readonly<{ ordering: Readonly<{ orderingKey: string; seq: number; epoch?: number; }>; }>;

function createResyncMessage(input: ResyncMessageInput): OrderedResyncMessage {
    const msg = newALUnicastMessage(
        'sender',
        { topicId: CHAT_ROUTE.topicId, resourceId: `message-${input.seq}`, contextId: 'room' },
        'receiver',
        input.typeId,
        { text: 'late' },
        { ttlMs: 60_000 }
    );
    return {
        ...msg,
        ordering: { orderingKey: 'chat', seq: input.seq, ...(input.epoch === undefined ? {} : { epoch: input.epoch }) }
    };
}

function toResync(msg: OrderedResyncMessage): ALInboundResyncRequired {
    return {
        msg,
        cursor: {
            orderingKey: msg.ordering.orderingKey,
            senderId: msg.id.senderId,
            epoch: msg.ordering.epoch ?? 0,
            lastContiguousSeq: 1,
            expectedSeq: 2,
            observedSeq: msg.ordering.seq,
            carrier: 'rtc'
        }
    };
}

interface RecoveryFixture {
    readonly owners: BrowserChannelRecoveryOwners;
    readonly recovery: BrowserResyncRecovery;
    readonly storage: ALStorageEvent[];
    readonly owner: RallarChannelRecovery;
    /** Every cursor the owner was handed, in order. */
    readonly invocations: ALInboundResyncCursor[];
    /** Moves the recovery's clock forward. */
    readonly advance: (ms: number) => void;
}

function createRecoveryFixture(): RecoveryFixture {
    const owners = new BrowserChannelRecoveryOwners();
    const storage: ALStorageEvent[] = [];
    const invocations: ALInboundResyncCursor[] = [];
    const owner: RallarChannelRecovery = { onResyncRequired: (cursor) => invocations.push(cursor) };
    let nowMs = 1_000;
    const recovery = new BrowserResyncRecovery({
        owners,
        storage: (event) => storage.push(event),
        nowMs: () => nowMs
    });
    return {
        owners,
        recovery,
        storage,
        owner,
        invocations,
        advance: (ms) => {
            nowMs += ms;
        }
    };
}

describe('the browser resync recovery', () => {
    it('invokes the route\'s owner once per ordering track and states it on the diagnostics port', () => {
        const fixture = createRecoveryFixture();
        fixture.owners.setOwner(CHAT_ROUTE, fixture.owner);
        const first = toResync(createResyncMessage({ typeId: CHAT_ROUTE.typeId, seq: 300 }));
        const again = toResync(createResyncMessage({ typeId: CHAT_ROUTE.typeId, seq: 301 }));

        fixture.recovery.onResyncRequired(first);
        fixture.recovery.onResyncRequired(again);

        expect(fixture.invocations).toEqual([first.cursor]);
        expect(fixture.storage).toEqual([{ kind: 'recovery-owner-invoked', ...first.cursor }]);
        // The black-box harness matches this event by `contains` on its serialised form, so its key order is a contract.
        expect(JSON.stringify(fixture.storage[0])).toBe(
            '{"kind":"recovery-owner-invoked","orderingKey":"chat","senderId":"sender","epoch":0,"lastContiguousSeq":1,"expectedSeq":2,"observedSeq":300,"carrier":"rtc"}'
        );
    });

    it('invokes the owner again for the sender\'s new epoch, which is a new track', () => {
        const fixture = createRecoveryFixture();
        fixture.owners.setOwner(CHAT_ROUTE, fixture.owner);
        const first = toResync(createResyncMessage({ typeId: CHAT_ROUTE.typeId, seq: 300 }));
        const nextEpoch = toResync(createResyncMessage({ typeId: CHAT_ROUTE.typeId, seq: 300, epoch: 1 }));

        fixture.recovery.onResyncRequired(first);
        fixture.recovery.onResyncRequired(nextEpoch);
        fixture.recovery.onResyncRequired(nextEpoch);

        expect(fixture.invocations).toEqual([first.cursor, nextEpoch.cursor]);
        expect(fixture.storage.map((event) => event.kind === 'recovery-owner-invoked' ? event.epoch : event.kind)).toEqual([0, 1]);
    });

    it('keeps a track that goes on resynchronizing invoked once', () => {
        const fixture = createRecoveryFixture();
        fixture.owners.setOwner(CHAT_ROUTE, fixture.owner);
        const first = toResync(createResyncMessage({ typeId: CHAT_ROUTE.typeId, seq: 300 }));

        fixture.recovery.onResyncRequired(first);
        fixture.advance(AL_VOLATILE_SESSION_MAX_AGE_MS);
        fixture.recovery.onResyncRequired(toResync(createResyncMessage({ typeId: CHAT_ROUTE.typeId, seq: 301 })));
        fixture.advance(AL_VOLATILE_SESSION_MAX_AGE_MS);
        fixture.recovery.onResyncRequired(toResync(createResyncMessage({ typeId: CHAT_ROUTE.typeId, seq: 302 })));

        expect(fixture.invocations).toEqual([first.cursor]);
    });

    it('invokes the owner again for a track it has not seen resynchronize for the session age budget', () => {
        const fixture = createRecoveryFixture();
        fixture.owners.setOwner(CHAT_ROUTE, fixture.owner);
        const first = toResync(createResyncMessage({ typeId: CHAT_ROUTE.typeId, seq: 300 }));
        const later = toResync(createResyncMessage({ typeId: CHAT_ROUTE.typeId, seq: 900 }));

        fixture.recovery.onResyncRequired(first);
        fixture.advance(AL_VOLATILE_SESSION_MAX_AGE_MS + 1);
        fixture.recovery.onResyncRequired(later);

        expect(fixture.invocations).toEqual([first.cursor, later.cursor]);
    });

    it('invokes nothing and states nothing for a route without an owner', () => {
        const fixture = createRecoveryFixture();
        fixture.owners.setOwner(CHAT_ROUTE, fixture.owner);

        fixture.recovery.onResyncRequired(toResync(createResyncMessage({ typeId: 'chat.other.v1', seq: 300 })));

        expect(fixture.invocations).toEqual([]);
        expect(fixture.storage).toEqual([]);
    });

    it('finds the owner of a channel that declared no topic by the message type alone', () => {
        const fixture = createRecoveryFixture();
        fixture.owners.setOwner({ typeId: CHAT_ROUTE.typeId }, fixture.owner);
        const resync = toResync(createResyncMessage({ typeId: CHAT_ROUTE.typeId, seq: 300 }));

        fixture.recovery.onResyncRequired(resync);

        expect(fixture.invocations).toEqual([resync.cursor]);
    });

    it('keeps a failing owner from the runtime and still states the invocation', () => {
        const fixture = createRecoveryFixture();
        const reported: string[] = [];
        const failing = vi.spyOn(console, 'error').mockImplementation((message: string) => {
            reported.push(message);
        });
        fixture.owners.setOwner(CHAT_ROUTE, {
            onResyncRequired: () => {
                throw new Error('owner failed');
            }
        });
        const resync = toResync(createResyncMessage({ typeId: CHAT_ROUTE.typeId, seq: 300 }));

        expect(() => fixture.recovery.onResyncRequired(resync)).not.toThrow();

        expect(reported).toEqual(['A channel recovery owner failed']);
        expect(fixture.storage).toEqual([{ kind: 'recovery-owner-invoked', ...resync.cursor }]);
        failing.mockRestore();
    });
});

describe('a typed channel\'s recovery owner', () => {
    it('is registered for the channel\'s route when the definition declares one', () => {
        const owners = new BrowserChannelRecoveryOwners();
        const recovery: RallarChannelRecovery = { onResyncRequired: () => {} };
        const channels = new BrowserTypedMessageChannels({
            inputValidator: new BrowserMessageInputValidator({ readMaxPayloadBytes: () => 64 * 1024 }),
            sender: createBrowserMessageSenderFixture().sender,
            rtc: { onMessage: () => () => {} },
            ws: { onMessage: () => () => {} },
            recoveryOwners: owners
        });

        channels.channel({ ...CHAT_ROUTE, purpose: 'command', recovery });
        channels.channel({ topicId: 'app.chat', typeId: 'chat.unowned.v1', purpose: 'command' });

        expect(owners.getOwner(createResyncMessage({ typeId: CHAT_ROUTE.typeId, seq: 300 }))).toBe(recovery);
        expect(owners.getOwner(createResyncMessage({ typeId: 'chat.unowned.v1', seq: 300 }))).toBeUndefined();
    });
});
