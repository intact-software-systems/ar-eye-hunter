import type { RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';

export interface PrefixSuffixReadBatchFixtureEntry {
    readonly namespace: string;
    readonly key: string;
}

export interface PrefixSuffixReadBatchFixtureSelection {
    readonly selectorId: string;
    readonly keys: readonly string[];
}

export interface PrefixSuffixReadBatchFixture {
    readonly entries: readonly PrefixSuffixReadBatchFixtureEntry[];
    readonly selectors: readonly RuntimeStateReadBatchSelector[];
    readonly expectedSelections: readonly PrefixSuffixReadBatchFixtureSelection[];
}

const SCOPE_PREFIX = 'app=bench:ws=w1:';

/**
 * Keys a SQL LIKE pattern, a locale sort or an overlapping prefix and suffix would get wrong. Every
 * suffix is matched literally: `%` and `_` are ordinary characters, and results are in UTF-8 byte order.
 */
export function createPrefixSuffixReadBatchFixture(
    namespace: string
): PrefixSuffixReadBatchFixture {
    const key = (tail: string): string => `${SCOPE_PREFIX}${tail}`;
    const inNamespace = (keys: readonly string[]): readonly PrefixSuffixReadBatchFixtureEntry[] =>
        keys.map((entryKey) => ({ namespace, key: entryKey }));
    return {
        entries: [
            ...inNamespace([
                key('group=g1:member=50%25_off'),
                key('group=g2:member=50ab25Xoff'),
                key('group=g3:member=a_c'),
                key('group=g3:member=abc'),
                key('group=g4:member=a%3Ab'),
                key('group=g5:member=a:b'),
                key('group=g6:member=%C3%BCn%C3%AF%F0%9F%98%80'),
                key('group=g6:member=ünï😀'),
                key('group=g7:member=alice'),
                key('group=g7:member=xalice'),
                key('group=a:member=alice'),
                key('group=_:member=alice'),
                key('group=B:member=alice'),
                key('group=%25:member=alice'),
                'app=bench:ws=w1x:group=g1:member=alice',
                'app=bench:ws=w1:member=alice'
            ]),
            { namespace: `${namespace}:sibling`, key: key('group=g7:member=alice') }
        ],
        selectors: [
            prefixSuffix(namespace, 'unicode-encoded', ':member=%C3%BCn%C3%AF%F0%9F%98%80'),
            prefixSuffix(namespace, 'percent', ':member=50%25_off'),
            { selectorId: 'exact', kind: 'key', namespace, key: key('group=g3:member=a_c') },
            prefixSuffix(namespace, 'underscore', ':member=a_c'),
            prefixSuffix(namespace, 'colon', ':member=a%3Ab'),
            prefixSuffix(namespace, 'unicode-raw', ':member=ünï😀'),
            prefixSuffix(namespace, 'alice', ':member=alice'),
            prefixSuffix(namespace, 'ali', ':member=ali'),
            { selectorId: 'prefix', kind: 'prefix', namespace, keyPrefix: key('group=g3:') }
        ],
        expectedSelections: [
            {
                selectorId: 'unicode-encoded',
                keys: [key('group=g6:member=%C3%BCn%C3%AF%F0%9F%98%80')]
            },
            { selectorId: 'percent', keys: [key('group=g1:member=50%25_off')] },
            { selectorId: 'exact', keys: [key('group=g3:member=a_c')] },
            { selectorId: 'underscore', keys: [key('group=g3:member=a_c')] },
            { selectorId: 'colon', keys: [key('group=g4:member=a%3Ab')] },
            { selectorId: 'unicode-raw', keys: [key('group=g6:member=ünï😀')] },
            {
                selectorId: 'alice',
                keys: [
                    key('group=%25:member=alice'),
                    key('group=B:member=alice'),
                    key('group=_:member=alice'),
                    key('group=a:member=alice'),
                    key('group=g7:member=alice')
                ]
            },
            { selectorId: 'ali', keys: [] },
            { selectorId: 'prefix', keys: [key('group=g3:member=a_c'), key('group=g3:member=abc')] }
        ]
    };
}

function prefixSuffix(
    namespace: string,
    selectorId: string,
    keySuffix: string
): RuntimeStateReadBatchSelector {
    return { selectorId, kind: 'prefix-suffix', namespace, keyPrefix: SCOPE_PREFIX, keySuffix };
}
