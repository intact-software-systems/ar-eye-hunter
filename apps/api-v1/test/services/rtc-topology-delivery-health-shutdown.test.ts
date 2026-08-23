import assert from 'node:assert/strict';

import { stopApiOnRtcTopologyDeliveryHealthFailure } from '../../src/runtime/rtc-topology/rtc-topology-delivery-health-shutdown.ts';

Deno.test('RTC topology delivery health failure stops claimers, sockets, tasks, then HTTP', async () => {
    const events: string[] = [];
    let rejectHealth: (error: Error) => void = () => undefined;
    const healthFailure = new Promise<never>((_resolve, reject) => {
        rejectHealth = reject;
    });
    const completion = stopApiOnRtcTopologyDeliveryHealthFailure({
        healthFailure,
        onHealthFailure: (error) => events.push(`health:${error.message}`),
        stopQueueWorkers: () => events.push('queue-workers'),
        closeWebSockets: () => events.push('websockets'),
        stopBackgroundTasks: () => {
            events.push('background-tasks');
        },
        shutdownHttp: () => {
            events.push('http');
            return Promise.resolve();
        },
        onShutdownStepFailure: () => events.push('unexpected-step-failure')
    });

    rejectHealth(new Error('lease lost'));
    await completion;

    assert.deepEqual(events, [
        'health:lease lost',
        'queue-workers',
        'websockets',
        'background-tasks',
        'http'
    ]);
});

Deno.test('RTC topology delivery shutdown still closes HTTP after an earlier step fails', async () => {
    const events: string[] = [];
    const healthFailure = Promise.reject<never>(new Error('lease lost'));
    await stopApiOnRtcTopologyDeliveryHealthFailure({
        healthFailure,
        onHealthFailure: () => events.push('health'),
        stopQueueWorkers: () => {
            events.push('queue-workers');
            throw new Error('queue stop failed');
        },
        closeWebSockets: () => events.push('websockets'),
        stopBackgroundTasks: () => {
            events.push('background-tasks');
        },
        shutdownHttp: () => {
            events.push('http');
            return Promise.resolve();
        },
        onShutdownStepFailure: (step) => events.push(`failed:${step}`)
    });

    assert.deepEqual(events, [
        'health',
        'queue-workers',
        'failed:queue-workers',
        'websockets',
        'background-tasks',
        'http'
    ]);
});
