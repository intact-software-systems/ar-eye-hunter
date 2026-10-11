import assert from 'node:assert/strict';

import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import {
    closeNativeAdmissionTestDatabase,
    stopNativeAdmissionTestRuntime,
    stopNativeReceiptScenario,
    type NativeAdmissionTestCleanup
} from './native-admission-test-cleanup.ts';

Deno.test('native cleanup retains the body failure while attempting and reporting every failing owned stage', async () => {
    const primaryFailure = new Error('room assertion failed');
    const failures = new Map([
        ['socket', new Error('socket failed')],
        ['disconnects', new Error('disconnects failed')],
        ['websocket', new Error('websocket failed')],
        ['listener', new Error('listener failed')],
        ['engine-stop', new Error('engine stop failed')],
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
            'Native admission cleanup failed: background tasks and database'
        ]
    );
});

Deno.test('native cleanup exposes labelled cleanup-only failures without replacing their causes', async () => {
    const listenerFailure = new Error('listener failed');
    const passFailure = new Error('engine stop failed');
    const fixture = createNativeAdmissionCleanupFixture(
        new Map([
            ['listener', listenerFailure],
            ['engine-stop', passFailure]
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
            'Native admission cleanup failed: engine stop'
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

Deno.test('native cleanup releases the database barrier and awaits shutdown after failed engine completion', async () => {
    const passFailure = new Error('final pass failed');
    const fixture = createNativeAdmissionCleanupFixture(new Map([['engine-stop', passFailure]]), undefined);

    await assert.rejects(stopNativeAdmissionTestRuntime(fixture.cleanup), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Native admission cleanup failed: engine stop');
        assert.equal(error.cause, passFailure);
        return true;
    });
    assert.deepEqual(fixture.calls.slice(-3), ['engine-stop', 'engine-barrier-released', 'background']);
});

Deno.test('native database close survives both progress failures and remains awaited by runtime shutdown', async () => {
    const primaryFailure = new Error('room assertion failed');
    const progressFailure = new Error('progress output failed');
    const fixture = createNativeAdmissionCleanupFixture(new Map(), primaryFailure);
    const databaseFinished = Promise.withResolvers<void>();
    const markers: string[] = [];
    let closeStarted = false;
    let closeCompleted = false;
    let cleanupCompleted = false;
    const cleanup = stopNativeAdmissionTestRuntime({
        ...fixture.cleanup,
        backgroundTasks: {
            stop: async () => {
                await fixture.cleanup.backgroundTasks.stop();
                await closeNativeAdmissionTestDatabase({
                    close: async () => {
                        closeStarted = true;
                        await databaseFinished.promise;
                        closeCompleted = true;
                    }
                }, (message) => {
                    markers.push(message);
                    throw progressFailure;
                });
            }
        }
    }).finally(() => {
        cleanupCompleted = true;
    });
    const rejection = assert.rejects(cleanup, (error) => error === primaryFailure);
    try {
        await fixture.cleanup.queueEngineStopped.promise;
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(closeStarted, true, 'Throwing start progress must not skip actual database close');
        assert.equal(closeCompleted, false);
        assert.equal(cleanupCompleted, false, 'Runtime shutdown must await delayed database close');
    }
    finally {
        databaseFinished.resolve();
        await rejection;
    }
    assert.equal(closeCompleted, true);
    assert.deepEqual(markers, [
        'Native admission cleanup: database close started',
        'Native admission cleanup: database close finished'
    ]);
    assert.equal(fixture.secondaryFailures.length, 1);
    const backgroundFailure = fixture.secondaryFailures[0].errors[0];
    assert.equal(backgroundFailure.message, 'Native admission cleanup failed: background tasks and database');
    assert.ok(backgroundFailure.cause instanceof AggregateError);
    assert.equal(backgroundFailure.cause.errors.length, 2);
    assert.ok(backgroundFailure.cause.errors[0] instanceof Error);
    assert.ok(backgroundFailure.cause.errors[1] instanceof Error);
    assert.equal(backgroundFailure.cause.errors[0].cause, progressFailure);
    assert.equal(backgroundFailure.cause.errors[1].cause, progressFailure);
});

Deno.test('native database close failure remains observable beside progress failure and body primary', async () => {
    const primaryFailure = new Error('room assertion failed');
    const closeFailure = new Error('database close failed');
    const progressFailure = new Error('progress output failed');
    const fixture = createNativeAdmissionCleanupFixture(new Map(), primaryFailure);
    let closeAttempted = false;
    await assert.rejects(
        stopNativeAdmissionTestRuntime({
            ...fixture.cleanup,
            backgroundTasks: {
                stop: async () => {
                    await fixture.cleanup.backgroundTasks.stop();
                    await closeNativeAdmissionTestDatabase({
                        close: () => {
                            closeAttempted = true;
                            return Promise.reject(closeFailure);
                        }
                    }, () => {
                        throw progressFailure;
                    });
                }
            }
        }),
        (error) => error === primaryFailure
    );
    assert.equal(closeAttempted, true, 'Progress failure must not hide a simultaneous real close failure');
    const backgroundFailure = fixture.secondaryFailures[0].errors[0];
    assert.ok(backgroundFailure.cause instanceof AggregateError);
    assert.equal(backgroundFailure.cause.errors.length, 2);
    assert.ok(backgroundFailure.cause.errors[0] instanceof Error);
    assert.ok(backgroundFailure.cause.errors[1] instanceof Error);
    assert.equal(backgroundFailure.cause.errors[0].cause, progressFailure);
    assert.equal(backgroundFailure.cause.errors[1].cause, closeFailure);
    assert.equal(backgroundFailure.cause.errors[0].message, 'Native admission cleanup failed: progress reporting');
    assert.equal(backgroundFailure.cause.errors[1].message, 'Native admission cleanup failed: database close');
});

function createNativeAdmissionCleanupFixture(failures: ReadonlyMap<string, Error>, primaryFailure: Error | undefined) {
    const calls: string[] = [];
    const secondaryFailures: AggregateError[] = [];
    const backgroundProducersStopped = Promise.withResolvers<void>();
    const queueEngineStopped = Promise.withResolvers<void>();
    const cleanup: NativeAdmissionTestCleanup = {
        ...createNativeAdmissionSessionCleanupFixture(calls, failures),
        ...createNativeAdmissionTransportCleanupFixture(calls, failures),
        ...createNativeAdmissionQueueCleanupFixture({ calls, failures, backgroundProducersStopped, queueEngineStopped }),
        backgroundProducersStopped: backgroundProducersStopped.promise,
        queueEngineStopped,
        primaryFailure,
        reportProgress: () => {},
        reportSecondaryFailures: (failure) => secondaryFailures.push(failure)
    };
    return { cleanup, calls, secondaryFailures };
}

function createNativeAdmissionSessionCleanupFixture(
    calls: string[],
    failures: ReadonlyMap<string, Error>
): Pick<NativeAdmissionTestCleanup, 'socketClosures' | 'waitForSessionDisconnects'> {
    return {
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
        }
    };
}

function createNativeAdmissionTransportCleanupFixture(
    calls: string[],
    failures: ReadonlyMap<string, Error>
): Pick<NativeAdmissionTestCleanup, 'webSocketLifecycle' | 'listener'> {
    return {
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
        }
    };
}

interface NativeAdmissionQueueCleanupFixture {
    readonly calls: string[];
    readonly failures: ReadonlyMap<string, Error>;
    readonly backgroundProducersStopped: PromiseWithResolvers<void>;
    readonly queueEngineStopped: PromiseWithResolvers<void>;
}

function createNativeAdmissionQueueCleanupFixture(
    fixture: NativeAdmissionQueueCleanupFixture
): Pick<NativeAdmissionTestCleanup, 'backgroundTasks' | 'engine'> {
    const { calls, failures, backgroundProducersStopped, queueEngineStopped } = fixture;
    return {
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
                return failure ? Promise.reject(failure) : Promise.resolve();
            }
        }
    };
}

Deno.test('native receipt registry failure preserves the original body Error and attempts every peer and fixture', async () => {
    const primaryFailure = new Error('original body');
    const registryFailure = new Error('registry release failed');
    const peerFailure = new Error('peer failed');
    const calls: string[] = [];
    const secondary: AggregateError[] = [];
    await assert.rejects(
        stopNativeReceiptScenario({
            releaseDeliveryRegistry: () => {
                calls.push('registry');
                throw registryFailure;
            },
            stopPeers: [
                () => {
                    calls.push('peer-one');
                    throw peerFailure;
                },
                () => {
                    calls.push('peer-two');
                    return Promise.resolve();
                }
            ],
            stopRuntime: async (peers, failure) => {
                calls.push('fixture');
                await Promise.allSettled(peers);
                if (failure) {
                    throw failure;
                }
            },
            primaryFailure,
            reportSecondaryFailures: (failure) => secondary.push(failure)
        }),
        (error) => error === primaryFailure
    );
    assert.deepEqual(calls, ['registry', 'peer-one', 'peer-two', 'fixture']);
    assert.equal(secondary.length, 1);
    assert.ok(secondary[0].errors.some((failure) => failure === registryFailure || failure.cause === registryFailure));
});

Deno.test('native cleanup keeps database closure behind real engine computation and resource release', async () => {
    const fixture = createNativeAdmissionCleanupFixture(new Map(), undefined);
    const engine = new InboxOutboxEngine();
    const computation = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const releasing = Promise.withResolvers<void>();
    let available = true;
    let databaseClosed = false;
    engine.includeTask('domain', {
        name: 'domain',
        maxConcurrency: () => 1,
        isWork: () => available,
        ongoingTasks: [],
        runnable: async () => {
            available = false;
            entered.resolve();
            try {
                await computation.promise;
            }
            finally {
                releasing.resolve();
                await release.promise;
            }
        }
    });
    await engine.executeOnce();
    await entered.promise;
    const stopping = stopNativeAdmissionTestRuntime({
        ...fixture.cleanup,
        engine,
        backgroundTasks: {
            stop: async () => {
                await fixture.cleanup.backgroundTasks.stop();
                databaseClosed = true;
            }
        }
    });
    try {
        await fixture.cleanup.backgroundProducersStopped;
        await engine.executeOnce();
        for (let index = 0; index < 6; index += 1) {
            await Promise.resolve();
        }
        assert.equal(databaseClosed, false, 'database closed before computation completed');
        computation.resolve();
        await releasing.promise;
        assert.equal(databaseClosed, false, 'database closed before resource release completed');
        release.resolve();
        await stopping;
        assert.equal(databaseClosed, true);
    }
    finally {
        computation.resolve();
        release.resolve();
        await stopping;
    }
});
