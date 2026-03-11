import { describe, expect, it, vi } from 'vitest';
import { newALMulticastMessage, newALRoute, } from '@shared/al-contracts/al-contract.ts';
import {
    createRallarFacade,
    matchesRallarMessageSelector,
    normalizeRallarMessageSelector,
} from '@shared-web/browser/rallar.ts';

describe('Rallar message selectors', () => {
    it('keeps string shorthand as a typeId selector', () => {
        expect(normalizeRallarMessageSelector('chat.message.v1')).toEqual({
            typeId: 'chat.message.v1',
        });
    });

    it('matches messages by topic, type, or both', () => {
        const message = newALMulticastMessage(
            'session-1',
            newALRoute('room.chat', 'room-1', 'message-1'),
            'room-1',
            'chat.message.v1',
            { text: 'hello' },
        );

        expect(
            matchesRallarMessageSelector(
                { topicId: 'room.chat', typeId: 'chat.message.v1' },
                message,
            ),
        ).toBe(true);
        expect(
            matchesRallarMessageSelector({ topicId: 'room.chat' }, message),
        ).toBe(true);
        expect(
            matchesRallarMessageSelector({ typeId: 'chat.message.v1' }, message),
        ).toBe(true);
        expect(
            matchesRallarMessageSelector(
                { topicId: 'room.cursor', typeId: 'chat.message.v1' },
                message,
            ),
        ).toBe(false);
        expect(
            matchesRallarMessageSelector(
                { topicId: 'room.chat', typeId: 'cursor.position.v1' },
                message,
            ),
        ).toBe(false);
    });

    it('allows RTC subscriptions to use topic and type selectors', () => {
        const facade = createRallarFacade();

        const unsubscribe = facade.messages.rtc.onMessage(
            { topicId: 'room.chat', typeId: 'chat.message.v1' },
            vi.fn(),
        );

        expect(unsubscribe).toEqual(expect.any(Function));
        unsubscribe();
    });

    it('keeps RTC string subscriptions backward compatible', () => {
        const facade = createRallarFacade();

        const unsubscribe = facade.messages.rtc.onMessage(
            'chat.message.v1',
            vi.fn(),
        );

        expect(unsubscribe).toEqual(expect.any(Function));
        unsubscribe();
    });

    it('rejects RTC topic-only subscriptions because the low-level RTC callback is type keyed', () => {
        const facade = createRallarFacade();

        expect(() =>
            facade.messages.rtc.onMessage({ topicId: 'room.chat' }, vi.fn())
        ).toThrow('RTC message subscriptions require a typeId.');
    });

    it('allows WS topic-only subscriptions', () => {
        const facade = createRallarFacade();

        const unsubscribe = facade.messages.ws.onMessage(
            { topicId: 'room.chat' },
            vi.fn(),
        );

        expect(unsubscribe).toEqual(expect.any(Function));
        unsubscribe();
    });
});
