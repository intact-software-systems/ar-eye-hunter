import { describe, expect, it, vi } from 'vitest';
import { createBlackBoxRallarCrdtController } from '../../shared-test/black-box-runner/browser/rallar-browser-runtime/crdt-controller.ts';
import { createBlackBoxRallarDirectorController } from '../../shared-test/black-box-runner/browser/rallar-browser-runtime/director-controller.ts';
import { createBlackBoxRallarMessagingController } from '../../shared-test/black-box-runner/browser/rallar-browser-runtime/messaging-controller.ts';
import { createBlackBoxRallarConsoleDiagnostics } from '../../shared-test/black-box-runner/browser/rallar-browser-runtime/diagnostics.ts';

describe('browser Rallar resource controllers', () => {
    it('reserves CRDT handles before asynchronous creation', async () => {
        let generation = 1;
        const controller = createBlackBoxRallarCrdtController<object>({
            generation: () => generation,
            isCurrent: candidate => candidate === generation,
        });
        let resolveOpen!: (document: object) => void;
        const first = controller.open(
            'doc',
            () =>
                new Promise(resolve => {
                    resolveOpen = resolve;
                }),
        );

        await expect(controller.open('doc', async () => ({}))).rejects.toThrow(
            'CRDT document handle is already open: doc',
        );
        expect(controller.pending()).toHaveLength(1);

        const document = {};
        resolveOpen(document);
        await expect(first).resolves.toBe(document);
        expect(controller.require('doc')).toBe(document);
        expect(controller.pending()).toHaveLength(0);

        const order: string[] = [];
        let releaseFirst!: () => void;
        const firstOperation = controller.run('doc', async () => {
            order.push('first-started');
            await new Promise<void>(resolve => {
                releaseFirst = resolve;
            });
            order.push('first-completed');
        });
        const secondOperation = controller.run('doc', async () => {
            order.push('second-started');
        });
        await vi.waitFor(() => {
            expect(order).toEqual(['first-started']);
        });
        releaseFirst();
        await Promise.all([firstOperation, secondOperation]);
        expect(order).toEqual(['first-started', 'first-completed', 'second-started']);

        const lease = controller.lease();
        generation += 1;
        expect(() => controller.assertCurrent(lease, 'CRDT operation completed after the runtime closed.')).toThrow(
            'CRDT operation completed after the runtime closed.',
        );
    });

    it('owns director relay handles synchronously', () => {
        let generation = 1;
        const controller = createBlackBoxRallarDirectorController<object>({
            generation: () => generation,
            isCurrent: candidate => candidate === generation,
        });
        const relay = {};
        const lease = controller.lease();

        controller.add('relay', relay);

        expect(controller.require('relay')).toBe(relay);
        expect(() => controller.add('relay', {})).toThrow('Director relay handle is already active: relay');
        expect(controller.take('relay')).toBe(relay);
        expect(controller.handles()).toEqual([]);
        generation += 1;
        expect(() => controller.assertCurrent(lease, 'Director operation completed after the runtime closed.')).toThrow(
            'Director operation completed after the runtime closed.',
        );
    });

    it('deduplicates and disposes WS subscriptions while fencing stale leases', () => {
        let generation = 1;
        const unsubscribe = vi.fn();
        const subscribe = vi.fn(() => unsubscribe);
        const controller = createBlackBoxRallarMessagingController({
            generation: () => generation,
            isCurrent: candidate => candidate === generation,
        });
        const lease = controller.lease();

        controller.ensureWsSubscription('chat', subscribe);
        controller.ensureWsSubscription('chat', subscribe);
        expect(subscribe).toHaveBeenCalledTimes(1);

        generation += 1;
        expect(() => controller.assertCurrent(lease, 'Rallar send completed after the runtime closed.')).toThrow(
            'Rallar send completed after the runtime closed.',
        );
        expect(controller.cleanupWsSubscriptions()).toBe(1);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('restores only the console diagnostic token being disposed', () => {
        const originalWarn = vi.fn();
        const consoleTarget = { warn: originalWarn };
        const warnings: string[] = [];
        const diagnostics = createBlackBoxRallarConsoleDiagnostics<string>({
            console: consoleTarget,
            activeConfig: () => undefined,
            onWarning: config => warnings.push(config),
        });
        const disposeFirst = diagnostics.install('first');
        const disposeSecond = diagnostics.install('second');

        disposeSecond();
        consoleTarget.warn('warning');
        expect(warnings).toEqual(['first']);
        expect(consoleTarget.warn).not.toBe(originalWarn);

        disposeFirst();
        expect(consoleTarget.warn).toBe(originalWarn);
    });
});
