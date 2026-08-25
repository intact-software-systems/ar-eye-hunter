import { createRallarFacade } from '@shared-web/browser/composition/create-rallar-facade.ts';
import { describe, expect, it } from 'vitest';

describe('Rallar realtime default channels', () => {
    it('creates JSON and room channels without explicit defaults', () => {
        const realtime = createRallarFacade().realtime;

        expect(realtime.json()).toMatchObject({
            send: expect.any(Function),
            on: expect.any(Function)
        });
        expect(realtime.room()).toMatchObject({
            send: expect.any(Function),
            on: expect.any(Function),
            status: expect.any(Function),
            wait: expect.any(Function)
        });
    });
});
