import { buildSync } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('observes foreign-realm listener and reporter rejections while delivery stays synchronous', () => {
    const bundled = buildSync({
        entryPoints: ['packages/shared/cache/synchronous-notifications.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        write: false
    }).outputFiles[0].text;
    const observation = execFileSync(process.execPath, [
        '-e',
        `${bundled}
        const vm = require('node:vm');
        const delivered = [];
        const reported = [];
        const unhandled = [];
        process.on('unhandledRejection', (reason) => unhandled.push(String(reason)));
        function foreignRejection(message) {
            return vm.runInNewContext('Promise.reject(reason)', { reason: new Error(message) });
        }
        const listenerResult = foreignRejection('foreign listener failed');
        const notifications = new module.exports.SynchronousNotifications((error) => {
            reported.push(error.message);
            return foreignRejection('foreign reporter failed');
        });
        notifications.subscribe(() => listenerResult);
        notifications.subscribe(() => { throw new Error('synchronous listener failed'); });
        notifications.subscribe((event) => { delivered.push(event); });
        notifications.capture(['committed']).publish();
        const synchronousDelivery = delivered.join(',') === 'committed';
        setImmediate(() => console.log(JSON.stringify({
            foreignIsLocalPromise: listenerResult instanceof Promise,
            synchronousDelivery, delivered, reported, unhandled
        })));
    `
    ], { encoding: 'utf8' });
    expect(JSON.parse(observation)).toEqual({
        foreignIsLocalPromise: false,
        synchronousDelivery: true,
        delivered: ['committed'],
        reported: ['synchronous listener failed', 'foreign listener failed'],
        unhandled: []
    });
});
