import assert from 'node:assert/strict';

import { stopNativeAdmissionTestRuntime, type NativeAdmissionTestCleanup } from './native-admission-test-cleanup.ts';

Deno.test('native cleanup retains the body failure while attempting and reporting every failing owned stage', async () => {
    const primaryFailure = new Error('room assertion failed');
    const failures = new Map([
        ['socket', new Error('socket failed')],
        ['disconnects', new Error('disconnects failed')],
        ['websocket', new Error('websocket failed')],
        ['listener', new Error('listener failed')],
        ['engine-stop', new Error('engine stop failed')],
        ['engine-pass', new Error('engine pass failed')],
        ['background', new Error('background failed')]
    ]);
    const fixture = createNativeAdmissionCleanupFixture(failures, primaryFailure);

    await assert.rejects(stopNativeAdmissionTestRuntime(fixture.cleanup), (error) => error === primaryFailure);

    assert.deepEqual(fixture.calls, [
        'socket',
        'disconnects',
        'websocket',
        'listener',
        'background-start',
        'engine-stop',
        'engine-pass',
        'engine-barrier-released',
        'background'
    ]);
    assert.equal(fixture.secondaryFailures.length, 1);
    assert.deepEqual(
        fixture.secondaryFailures[0].errors.map((error) => {
            assert.ok(error instanceof Error);
            return error.message;
        }),
        [
            'Native admission cleanup failed: socket 0',
            'Native admission cleanup failed: authoritative disconnects',
            'Native admission cleanup failed: websocket lifecycle',
            'Native admission cleanup failed: listener',
            'Native admission cleanup failed: engine stop',
            'Native admission cleanup failed: final engine pass',
            'Native admission cleanup failed: background tasks and database'
        ]
    );
});

Deno.test('native cleanup exposes labelled cleanup-only failures without replacing their causes', async () => {
    const listenerFailure = new Error('listener failed');
    const passFailure = new Error('pass failed');
    const fixture = createNativeAdmissionCleanupFixture(
        new Map([
            ['listener', listenerFailure],
            ['engine-pass', passFailure]
        ]),
        undefined
    );

    await assert.rejects(stopNativeAdmissionTestRuntime(fixture.cleanup), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.equal(error.errors[0].cause, listenerFailure);
        assert.equal(error.errors[1].cause, passFailure);
        assert.deepEqual(error.errors.map((failure) => failure.message), [
            'Native admission cleanup failed: listener',
            'Native admission cleanup failed: final engine pass'
        ]);
        return true;
    });
    assert.ok(fixture.calls.includes('engine-barrier-released'));
    assert.ok(fixture.calls.includes('background'));
    assert.equal(fixture.secondaryFailures.length, 0);
});

Deno.test('native cleanup awaits every socket closure and the final background join', async () => {
    const fixture = createNativeAdmissionCleanupFixture(new Map(), undefined);
    const socketFinished = Promise.withResolvers<void>();
    const backgroundFinished = Promise.withResolvers<void>();
    const backgroundEntered = Promise.withResolvers<void>();
    let completed = false;
    let socketReleased = false;
    const cleanup = stopNativeAdmissionTestRuntime({
        ...fixture.cleanup,
        socketClosures: [Promise.reject(new Error('one socket failed')), socketFinished.promise],
        backgroundTasks: {
            stop: async () => {
                assert.equal(socketReleased, true, 'Background shutdown must wait for every socket closure');
                backgroundEntered.resolve();
                await fixture.cleanup.backgroundTasks.stop();
                await backgroundFinished.promise;
            }
        }
    }).then(() => {
        completed = true;
    }, (error) => {
        completed = true;
        throw error;
    });
    const rejection = assert.rejects(cleanup, /Native admission cleanup failed: socket 0/);

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(completed, false);
    assert.equal(fixture.calls.includes('disconnects'), false);
    socketReleased = true;
    socketFinished.resolve();
    await backgroundEntered.promise;
    await fixture.cleanup.queueEngineStopped.promise;
    assert.equal(completed, false);
    backgroundFinished.resolve();
    await rejection;
    assert.equal(completed, true);
    assert.ok(fixture.calls.includes('disconnects'));
    assert.ok(fixture.calls.includes('background'));
});

Deno.test('native cleanup releases the database barrier and awaits shutdown after a failed final pass', async () => {
    const passFailure = new Error('final pass failed');
    const fixture = createNativeAdmissionCleanupFixture(new Map([['engine-pass', passFailure]]), undefined);

    await assert.rejects(stopNativeAdmissionTestRuntime(fixture.cleanup), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Native admission cleanup failed: final engine pass');
        assert.equal(error.cause, passFailure);
        return true;
    });
    assert.deepEqual(fixture.calls.slice(-3), ['engine-pass', 'engine-barrier-released', 'background']);
});

function createNativeAdmissionCleanupFixture(failures: ReadonlyMap<string, Error>, primaryFailure: Error | undefined) {
    const calls: string[] = [];
    const secondaryFailures: AggregateError[] = [];
    const backgroundProducersStopped = Promise.withResolvers<void>();
    const queueEngineStopped = Promise.withResolvers<void>();
    const cleanup: NativeAdmissionTestCleanup = {
        socketClosures: [
            Promise.resolve().then(() => {
                calls.push('socket');
                const failure = failures.get('socket');
                if (failure) {
                    throw failure;
                }
            })
        ],
        waitForSessionDisconnects: () => {
            calls.push('disconnects');
            const failure = failures.get('disconnects');
            if (failure) {
                return Promise.reject(failure);
            }
            return Promise.resolve();
        },
        webSocketLifecycle: {
            dispose: () => {
                calls.push('websocket');
                const failure = failures.get('websocket');
                if (failure) {
                    return Promise.reject(failure);
                }
                return Promise.resolve();
            }
        },
        listener: {
            shutdown: () => {
                calls.push('listener');
                const failure = failures.get('listener');
                if (failure) {
                    return Promise.reject(failure);
                }
                return Promise.resolve();
            }
        },
        backgroundTasks: {
            stop: async () => {
                calls.push('background-start');
                backgroundProducersStopped.resolve();
                await queueEngineStopped.promise;
                calls.push('engine-barrier-released');
                calls.push('background');
                const failure = failures.get('background');
                if (failure) {
                    throw failure;
                }
            }
        },
        engine: {
            stop: () => {
                calls.push('engine-stop');
                const failure = failures.get('engine-stop');
                if (failure) {
                    throw failure;
                }
            },
            executeOnce: () => {
                calls.push('engine-pass');
                const failure = failures.get('engine-pass');
                if (failure) {
                    return Promise.reject(failure);
                }
                return Promise.resolve(false);
            }
        },
        backgroundProducersStopped: backgroundProducersStopped.promise,
        queueEngineStopped,
        primaryFailure,
        reportProgress: () => {},
        reportSecondaryFailures: (failure) => secondaryFailures.push(failure)
    };
    return { cleanup, calls, secondaryFailures };
}
