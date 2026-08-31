import { createRallarLifecycleCoordinator, type RallarLifecycleParticipant } from '@shared-web/browser/session/rallar-lifecycle-coordinator.ts';
import { describe, expect, it } from 'vitest';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

describe('Rallar lifecycle coordinator', () => {
    it('runs every lifecycle phase in ascending participant order', () => {
        const events: string[] = [];
        const lifecycle = createRallarLifecycleCoordinator();
        const participant = (
            id: string,
            order: number
        ): RallarLifecycleParticipant => ({
            id,
            order,
            attach: () => events.push(`attach:${id}`),
            connected: () => events.push(`connected:${id}`),
            detach: () => events.push(`detach:${id}`),
            disconnected: () => events.push(`disconnected:${id}`)
        });

        lifecycle.register(participant('rtc', 60));
        lifecycle.register(participant('state', 20));
        lifecycle.register(participant('messages', 30));
        const middleware = createDefaultApiMiddlewareTestDouble();

        lifecycle.attach(middleware);
        lifecycle.connected();
        lifecycle.detach(middleware);
        lifecycle.disconnected();

        expect(events).toEqual([
            'attach:state',
            'attach:messages',
            'attach:rtc',
            'connected:state',
            'connected:messages',
            'connected:rtc',
            'detach:state',
            'detach:messages',
            'detach:rtc',
            'disconnected:state',
            'disconnected:messages',
            'disconnected:rtc'
        ]);
    });

    it('rejects duplicate lifecycle participant ids', () => {
        const lifecycle = createRallarLifecycleCoordinator();
        lifecycle.register({ id: 'state', order: 20 });

        expect(() => lifecycle.register({ id: 'state', order: 30 })).toThrow(
            'Duplicate Rallar lifecycle participant: state'
        );
    });
});
