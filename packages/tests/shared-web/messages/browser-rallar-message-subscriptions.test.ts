import { createRallarFacade } from '@shared-web/browser/rallar.ts';
import { describe, expect, it, vi } from 'vitest';

describe('browser Rallar message subscriptions', () => {
    it('allows RTC subscriptions to use topic and type selectors', () => {
        const facade = createRallarFacade();

        const unsubscribe = facade.messages.rtc.onMessage(
            { topicId: 'room.chat', typeId: 'chat.message.v1' },
            vi.fn()
        );

        expect(unsubscribe).toEqual(expect.any(Function));
        unsubscribe();
    });

    it('accepts an RTC string selector as canonical typeId shorthand', () => {
        const facade = createRallarFacade();

        const unsubscribe = facade.messages.rtc.onMessage(
            'chat.message.v1',
            vi.fn()
        );

        expect(unsubscribe).toEqual(expect.any(Function));
        unsubscribe();
    });

    it('rejects RTC topic-only subscriptions because the low-level callback is type keyed', () => {
        const facade = createRallarFacade();

        expect(() => facade.messages.rtc.onMessage({ topicId: 'room.chat' }, vi.fn())).toThrow('RTC message subscriptions require a typeId.');
    });

    it('allows WS topic-only subscriptions', () => {
        const facade = createRallarFacade();

        const unsubscribe = facade.messages.ws.onMessage(
            { topicId: 'room.chat' },
            vi.fn()
        );

        expect(unsubscribe).toEqual(expect.any(Function));
        unsubscribe();
    });
});
