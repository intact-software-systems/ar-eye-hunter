import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import { toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';

import { TestResourceInbox } from '../test-support/app-inbox-resource-fixtures.ts';

const key = { topicId: 'app-inbox.client-state', contextId: 'context-1', resourceId: 'request-1' };

function placeholder() {
    const entry = toResourceEntryWithKey(key, 'APP_INBOX', { command: 'placeholder' });
    return { ...entry, audit: { ...entry.audit, expiryTs: Temporal.Instant.from('2000-01-01T00:00:01Z') } };
}

describe('AppInbox fake materialization ownership', () => {
    it('reuses an active row under its injected historical clock', async () => {
        const queue = new TestResourceInbox(new Map(), () => Temporal.Instant.from('2000-01-01T00:00:00Z'));
        const existing = placeholder();
        await queue.enqueue(existing);
        const entry = await queue.writeMaterializedIfAbsentOrReplaceExpired(placeholder(), async () => {
            throw new Error('An active row must not require materialization');
        });
        expect(entry).toEqual(existing);
    });

    it('cleans up a rejected materialization so the same key can be retried', async () => {
        const queue = new TestResourceInbox(new Map(), () => Temporal.Instant.from('2000-01-01T00:00:00Z'));
        const failure = new Error('materialization failed');
        await expect(queue.writeMaterializedIfAbsentOrReplaceExpired(placeholder(), async () => {
            throw failure;
        })).rejects.toBe(failure);
        const recovered = await queue.writeMaterializedIfAbsentOrReplaceExpired(placeholder(), async () => ({ ...placeholder(), resource: 'materialized' }));
        expect(recovered.resource).toBe('materialized');
        expect(await queue.getItem(key)).toEqual(recovered);
    });

    it('shares active materialization and replaces an expired row at the same key', async () => {
        let now = Temporal.Instant.from('2000-01-01T00:00:00Z');
        const queue = new TestResourceInbox(new Map(), () => now);
        let releaseGate: () => void = () => undefined;
        queue.delayNextMaterializationUntil(
            new Promise<void>((resolve) => {
                releaseGate = resolve;
            })
        );
        const materialize = async () => ({ ...placeholder(), resource: 'materialized' });
        const first = queue.writeMaterializedIfAbsentOrReplaceExpired(placeholder(), materialize);
        const second = queue.writeMaterializedIfAbsentOrReplaceExpired(placeholder(), async () => {
            throw new Error('Active materialization must be reused');
        });
        releaseGate();
        expect(await second).toEqual(await first);
        now = Temporal.Instant.from('2000-01-01T00:00:01Z');
        const replacement = { ...placeholder(), audit: { ...placeholder().audit, expiryTs: now.add({ seconds: 1 }) } };
        expect((await queue.writeMaterializedIfAbsentOrReplaceExpired(replacement, async () => ({ ...replacement, resource: 'replacement' }))).resource).toBe(
            'replacement'
        );
    });
});
