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
