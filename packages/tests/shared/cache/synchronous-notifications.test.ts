import { expect, it } from 'vitest';

import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';

it('publishes a snapshot synchronously once, despite listener and reporter failures', () => {
    const delivered: string[] = [];
    const errors: string[] = [];
    const notifications = new SynchronousNotifications<string>((error) => {
        errors.push(error.message);
        throw new Error('reporting failed');
    });
    notifications.subscribe(() => {
        throw new Error('listener failed');
    });
    const subscription = notifications.subscribe((value) => {
        delivered.push(value);
    });
    const changes = ['a', 'b'];
    const publication = notifications.capture(changes);
    changes.push('not captured');
    subscription.unsubscribe();
    notifications.subscribe(() => {
        delivered.push('late listener');
    });
    publication.publish();
    publication.publish();
    expect(delivered).toEqual(['a', 'b']);
    expect(errors).toEqual(['listener failed', 'listener failed']);
});

it('observes rejected listener promises without awaiting them or interrupting synchronous delivery', async () => {
    const errors: string[] = [];
    const delivered: string[] = [];
    const rejected = Promise.reject(new Error('async listener failed'));
    void rejected.catch(() => {});
    const notifications = new SynchronousNotifications<string>((error) => {
        errors.push(error.message);
    });
    notifications.subscribe(() => rejected);
    notifications.subscribe((event) => {
        delivered.push(event);
    });
    notifications.capture(['committed']).publish();
    expect(delivered).toEqual(['committed']);
    await rejected.catch(() => {});
    expect(errors).toEqual(['async listener failed']);
});

it('replays current state and publishes later state in the same turn until unsubscribe', () => {
    const delivered: string[] = [];
    const notifications = new SynchronousNotifications<string>(() => {});
    const subscription = notifications.subscribeAndNotify((state) => {
        delivered.push(state);
    }, 'idle');
    expect(delivered).toEqual(['idle']);
    notifications.publishLatest('loading');
    expect(delivered).toEqual(['idle', 'loading']);
    subscription.unsubscribe();
    notifications.publishLatest('ready');
    expect(delivered).toEqual(['idle', 'loading']);
});

it('stops an obsolete state publication when a listener publishes newer state', () => {
    const delivered: string[] = [];
    const notifications = new SynchronousNotifications<string>(() => {});
    notifications.subscribe((state) => {
        delivered.push(`first:${state}`);
        if (state === 'ready') {
            notifications.publishLatest('idle');
        }
    });
    notifications.subscribe((state) => {
        delivered.push(`second:${state}`);
    });
    notifications.publishLatest('ready');
    expect(delivered).toEqual(['first:ready', 'first:idle', 'second:idle']);
});

it('delivers current state once to new registrations and protects them from stale unsubscribe handles', () => {
    const delivered: string[] = [];
    const notifications = new SynchronousNotifications<string>(() => {});
    const replacedListener = (state: string): void => {
        delivered.push(`replaced:${state}`);
    };
    notifications.subscribe((state) => {
        delivered.push(`first:${state}`);
        if (state === 'ready') {
            stale.unsubscribe();
            notifications.subscribeAndNotify(replacedListener, state);
            stale.unsubscribe();
            notifications.subscribeAndNotify((current) => {
                delivered.push(`added:${current}`);
            }, state);
        }
    });
    const stale = notifications.subscribe(replacedListener);
    notifications.publishLatest('ready');
    notifications.publishLatest('idle');
    expect(delivered).toEqual([
        'first:ready',
        'replaced:ready',
        'added:ready',
        'first:idle',
        'replaced:idle',
        'added:idle'
    ]);
});

it('isolates listener and reporter failures during replay and latest-state publication', () => {
    const delivered: string[] = [];
    const errors: string[] = [];
    const notifications = new SynchronousNotifications<string>((error) => {
        errors.push(error.message);
        throw new Error('reporter failed');
    });
    notifications.subscribeAndNotify((state) => {
        throw new Error(`listener failed:${state}`);
    }, 'idle');
    notifications.subscribe((state) => {
        delivered.push(state);
    });
    notifications.publishLatest('ready');
    expect(errors).toEqual(['listener failed:idle', 'listener failed:ready']);
    expect(delivered).toEqual(['ready']);
});

it('renews replay during a publication without delivering that publication twice', () => {
    const delivered: string[] = [];
    const notifications = new SynchronousNotifications<string>(() => {});
    const listener = (state: string): void => {
        delivered.push(state);
    };
    notifications.subscribe((state) => {
        if (state === 'ready') {
            notifications.subscribeAndNotify(listener, state);
        }
    });
    const previous = notifications.subscribe(listener);
    notifications.publishLatest('ready');
    expect(delivered).toEqual(['ready']);
    previous.unsubscribe();
    notifications.publishLatest('idle');
    expect(delivered).toEqual(['ready', 'idle']);
});

it('keeps plain subscription deduplication and captured batches independent of replay renewal', () => {
    const delivered: string[] = [];
    const notifications = new SynchronousNotifications<string>(() => {});
    const listener = (state: string): void => {
        delivered.push(state);
    };
    const first = notifications.subscribe(listener);
    notifications.subscribe(listener);
    const captured = notifications.capture(['committed']);
    first.unsubscribe();
    notifications.publishLatest('not subscribed');
    captured.publish();
    expect(delivered).toEqual(['committed']);
});
