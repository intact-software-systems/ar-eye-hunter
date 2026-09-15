import { decodeRetentionCleanupQuery } from '../src/retention-query.ts';
import { assertJsonEquals } from './support/control-service-test-fixtures.ts';

function decode(query = '') {
    return decodeRetentionCleanupQuery(new URL(`http://control.test/retention/cleanup${query}`));
}

Deno.test('retention query preserves immediate mode and ignores unknown immediate fields', () => {
    assertJsonEquals(decode().right, { mode: 'immediate' });
    assertJsonEquals(decode('?unknown=value&token=immediate-admin-query-token').right, { mode: 'immediate' });
});

Deno.test('retention query accepts only exact preview and guarded-confirm shapes', () => {
    assertJsonEquals(decode('?dryRun=true').right, { mode: 'preview' });
    assertJsonEquals(decode('?planToken=v1.abc.def_123-XYZ').right, {
        mode: 'confirm',
        planToken: 'v1.abc.def_123-XYZ'
    });
});

Deno.test('retention query rejects duplicates invalid values and incompatible modes', () => {
    for (
        const [query, error] of [
            ['?dryRun=false', 'dryRun must be exactly true when provided.'],
            ['?dryRun=', 'dryRun must be exactly true when provided.'],
            ['?dryRun=true&dryRun=true', 'Retention preview and confirmation query values must not be duplicated.'],
            ['?planToken=', 'planToken is malformed.'],
            ['?planToken=not-a-versioned-token', 'planToken is malformed.'],
            [
                '?planToken=v1.abc.def&planToken=v1.abc.def',
                'Retention preview and confirmation query values must not be duplicated.'
            ],
            ['?dryRun=true&planToken=v1.abc.def', 'Retention preview and confirmation cannot be requested together.'],
            [`?planToken=${'a'.repeat(513)}`, 'planToken is malformed.']
        ]
    ) {
        const decoded = decode(query);
        assertJsonEquals(decoded.right, undefined);
        assertJsonEquals(decoded.left, error);
    }
});
