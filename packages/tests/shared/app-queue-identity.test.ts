import { describe, expect, it } from 'vitest';

import { toAppQueueKey, toStrictAppInboxQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';

describe('App queue identity bounds', () => {
    it('keeps valid maximum HTTP request IDs exact and suffix-distinct', () => {
        const commonPrefix = 'request-'.padEnd(120, 'x');
        const firstRequestId = `${commonPrefix}suffix-a`;
        const secondRequestId = `${commonPrefix}suffix-b`;

        const first = toStrictAppInboxQueueKey({
            topicId: 'operation',
            resourceId: firstRequestId,
            contextId: 'caller'
        });
        const second = toStrictAppInboxQueueKey({
            topicId: 'operation',
            resourceId: secondRequestId,
            contextId: 'caller'
        });

        expect(first.resourceId).toBe(firstRequestId);
        expect(second.resourceId).toBe(secondRequestId);
        expect(first.resourceId).not.toBe(second.resourceId);
    });

    it('keeps long scoped contexts distinct beyond the historical 35-character bound', () => {
        const commonPrefix = 'caller-and-target-'.padEnd(96, 'y');
        const firstContextId = `${commonPrefix}scope-a`;
        const secondContextId = `${commonPrefix}scope-b`;

        const first = toStrictAppInboxQueueKey({
            topicId: 'operation',
            resourceId: 'short-request',
            contextId: firstContextId
        });
        const second = toStrictAppInboxQueueKey({
            topicId: 'operation',
            resourceId: 'short-request',
            contextId: secondContextId
        });

        expect(first.contextId).toBe(firstContextId);
        expect(second.contextId).toBe(secondContextId);
        expect(first.contextId).not.toBe(second.contextId);
    });

    it('does not rewrite legacy short queue keys', () => {
        const key = {
            topicId: 'legacy-topic',
            resourceId: 'legacy-resource',
            contextId: 'legacy-context'
        };

        expect(toAppQueueKey(key)).toEqual(key);
    });

    it('preserves legacy long-key normalization for non-HTTP transports', () => {
        const legacyResourceId = `legacy-${'w'.repeat(80)}`;

        expect(
            toAppQueueKey({
                topicId: 'legacy-topic',
                resourceId: legacyResourceId,
                contextId: 'legacy-context'
            }).resourceId
        ).toBe('legacy-wwwwwwwwwwwwwwww-apr5tuetw8ux');
    });
});
