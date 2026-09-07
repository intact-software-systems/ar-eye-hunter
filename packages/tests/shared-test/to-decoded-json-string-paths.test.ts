import { describe, expect, it } from 'vitest';

import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import {
    toDecodedJsonStringPaths
} from '../../shared-test/black-box-runner/expectations/to-decoded-json-string-paths.ts';

const frame: ApiJsonValue = {
    route: { topicId: 'group-state.event' },
    payload: {
        typeId: 'group-state.delta.v1',
        resource: '{"event":{"eventType":"group-activation-status-changed"},"revision":7}'
    }
};

describe('toDecodedJsonStringPaths', () => {
    it('decodes a declared JSON-string field so a nested value becomes matchable', () => {
        const decoded = toDecodedJsonStringPaths(frame, ['payload.resource']) as never;

        expect(decoded).toMatchObject({
            payload: { resource: { event: { eventType: 'group-activation-status-changed' } } }
        });
    });

    it('leaves the frame untouched when no path is declared', () => {
        expect(toDecodedJsonStringPaths(frame, [])).toBe(frame);
    });

    it('leaves siblings and the outer shape intact', () => {
        const decoded = toDecodedJsonStringPaths(frame, ['payload.resource']) as never;

        expect(decoded).toMatchObject({
            route: { topicId: 'group-state.event' },
            payload: { typeId: 'group-state.delta.v1' }
        });
    });

    // A frame that does not carry the nested document must fail the expectation
    // on its own terms rather than vanish from the candidate set.
    it('leaves a path whose value is not JSON exactly as it was', () => {
        const plain: ApiJsonValue = { payload: { resource: 'not-json-at-all' } };

        expect(toDecodedJsonStringPaths(plain, ['payload.resource'])).toEqual(plain);
    });

    it('leaves an absent path alone', () => {
        const other: ApiJsonValue = { payload: { typeId: 'something.else' } };

        expect(toDecodedJsonStringPaths(other, ['payload.resource'])).toEqual(other);
    });

    it('does not mutate the frame it was given', () => {
        const before = JSON.stringify(frame);
        toDecodedJsonStringPaths(frame, ['payload.resource']);

        expect(JSON.stringify(frame)).toBe(before);
    });

    it('decodes several declared paths', () => {
        const two: ApiJsonValue = { a: '{"x":1}', b: '{"y":2}', c: 'kept' };

        expect(toDecodedJsonStringPaths(two, ['a', 'b'])).toEqual({ a: { x: 1 }, b: { y: 2 }, c: 'kept' });
    });
});
