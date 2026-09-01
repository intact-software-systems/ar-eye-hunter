import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { BlackBoxRallarCrdtResourceController } from '../../shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-crdt-resource-controller.ts';
import { createBlackBoxRallarConsoleDiagnostics } from '../../shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts';
import { BlackBoxRallarDirectorResourceController } from '../../shared-test/black-box-runner/browser/rallar-browser-runtime/director-controller.ts';
import { createBlackBoxRallarMessagingResourceController } from '../../shared-test/black-box-runner/browser/rallar-browser-runtime/messaging-controller.ts';

describe('browser Rallar resource controllers', () => {
    it('reserves CRDT handles before asynchronous creation', async () => {
        let generation = 1;
        const controller = new BlackBoxRallarCrdtResourceController<object>({
            generation: () => generation,
            isCurrent: (candidate) => candidate === generation
        });
        const opening = Promise.withResolvers<object>();
        const first = controller.open(
            'doc',
            () => opening.promise
        );

        await expect(controller.open('doc', async () => ({}))).rejects.toThrow(
            'CRDT document handle is already open: doc'
        );
        expect(controller.pending()).toHaveLength(1);

        const document = {};
        opening.resolve(document);
        await expect(first).resolves.toBe(document);
        expect(controller.require('doc')).toBe(document);
        expect(controller.pending()).toHaveLength(0);

        const order: string[] = [];
        const firstOperationCompletion = Promise.withResolvers<void>();
        const firstOperation = controller.run('doc', async () => {
            order.push('first-started');
            await firstOperationCompletion.promise;
            order.push('first-completed');
        });
        const secondOperation = controller.run('doc', async () => {
            order.push('second-started');
        });
        await vi.waitFor(() => {
            expect(order).toEqual(['first-started']);
        });
        firstOperationCompletion.resolve();
        await Promise.all([firstOperation, secondOperation]);
        expect(order).toEqual(['first-started', 'first-completed', 'second-started']);

        const lease = controller.lease();
        generation += 1;
        expect(() => controller.assertCurrent(lease, 'CRDT operation completed after the runtime closed.')).toThrow(
            'CRDT operation completed after the runtime closed.'
        );
    });

    it('keeps a CRDT handle reserved until destructive release succeeds', async () => {
        const controller = new BlackBoxRallarCrdtResourceController<object>({
            generation: () => 1,
            isCurrent: (candidate) => candidate === 1
        });
        const document = {};
        await controller.open('doc', async () => document);
        const releaseStarted = Promise.withResolvers<void>();
        const releaseCompletion = Promise.withResolvers<void>();
        const releasing = controller.release(
            'doc',
            () => {
                releaseStarted.resolve();
                return releaseCompletion.promise;
            }
        );
        await releaseStarted.promise;

        await expect(controller.open('doc', async () => ({}))).rejects.toThrow(
            'CRDT document handle is already open: doc'
        );
        expect(controller.entries()).toEqual([['doc', document]]);

        releaseCompletion.resolve();
        await releasing;
        expect(controller.handles()).toEqual([]);
    });

    it('retains a CRDT document when destructive release fails', async () => {
        const controller = new BlackBoxRallarCrdtResourceController<object>({
            generation: () => 1,
            isCurrent: (candidate) => candidate === 1
        });
        const document = {};
        await controller.open('doc', async () => document);

        await expect(
            controller.release('doc', async () => {
                throw new Error('close failed');
            })
        ).rejects.toThrow('close failed');

        expect(controller.require('doc')).toBe(document);
        expect(controller.handles()).toEqual(['doc']);
    });

    it('owns director relay handles synchronously', () => {
        let generation = 1;
        const controller = new BlackBoxRallarDirectorResourceController<object>({
            generation: () => generation,
            isCurrent: (candidate) => candidate === generation
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
            'Director operation completed after the runtime closed.'
        );
    });

    it('deduplicates and disposes WS subscriptions while fencing stale leases', () => {
        let generation = 1;
        const unsubscribe = vi.fn();
        const subscribe = vi.fn(() => unsubscribe);
        const controller = createBlackBoxRallarMessagingResourceController({
            generation: () => generation,
            isCurrent: (candidate) => candidate === generation
        });
        const lease = controller.lease();

        controller.ensureWsSubscription('chat', subscribe);
        controller.ensureWsSubscription('chat', subscribe);
        expect(subscribe).toHaveBeenCalledTimes(1);

        generation += 1;
        expect(() => controller.assertCurrent(lease, 'Rallar send completed after the runtime closed.')).toThrow(
            'Rallar send completed after the runtime closed.'
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
            onWarning: (config) => warnings.push(config)
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
