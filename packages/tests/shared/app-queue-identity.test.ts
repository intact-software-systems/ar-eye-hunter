import { describe, expect, it } from 'vitest';

import {
    fnv1a64,
    toAppQueueKey,
    toStrictAppInboxQueueKey
} from '@shared/queuebox/AppQueueIdentity.ts';

describe('App queue checksum', () => {
    it.each([
        ['', '33niihzj4ux45'],
        ['a', '2o0ongoiv4rrg'],
        ['foobar', '214ng2xt5fmco'],
        ['Rallar', '2pq2mo53r6mxz'],
        ['é', '2o0q4gvawodr8'],
        ['漢', '2o3tmg1hf6qqt'],
        ['😀', '3huu70miqwp20'],
        ['\ud800', '2ohayon3z7jz3'],
        ['\udc00', '2ohm1s6dy4uzj'],
        ['\0\n\r\t\\"', '21ecehvi7o11f']
    ])('preserves the base-36 checksum for %j', (value, expected) => {
        expect(fnv1a64(value)).toBe(expected);
    });

    it('hashes every UTF-16 code unit without changing surrogate semantics', () => {
        const value = Array.from({ length: 65_536 }, (_, codeUnit) => String.fromCharCode(codeUnit)).join('');

        expect(fnv1a64(value)).toBe('2wo6dmh01qm1x');
    });

    it('preserves wraparound for a long snapshot containing non-ASCII and escaped text', () => {
        const value = 'snapshot:漢😀\\"'.repeat(8_192);

        expect(fnv1a64(value)).toBe('1uitafg9k84yt');
    });
});

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
