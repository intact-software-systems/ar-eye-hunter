import { parseRetentionCleanupQuery } from '../src/retention-query.ts';

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected, null, 2)}, got ${JSON.stringify(actual, null, 2)}`,
    );
  }
}

function parse(query = '') {
  return parseRetentionCleanupQuery(new URL(`http://control.test/retention/cleanup${query}`));
}

Deno.test('retention query preserves legacy mode and ignores unknown legacy fields', () => {
  assertEquals(parse(), { mode: 'legacy' });
  assertEquals(parse('?unknown=value&token=legacy-admin-query-token'), { mode: 'legacy' });
});

Deno.test('retention query accepts only exact preview and guarded-confirm shapes', () => {
  assertEquals(parse('?dryRun=true'), { mode: 'preview' });
  assertEquals(parse('?planToken=v1.abc.def_123-XYZ'), {
    mode: 'confirm',
    planToken: 'v1.abc.def_123-XYZ',
  });
});

Deno.test('retention query rejects duplicates invalid values and incompatible modes', () => {
  for (
    const query of [
      '?dryRun=false',
      '?dryRun=',
      '?dryRun=true&dryRun=true',
      '?planToken=',
      '?planToken=not-a-versioned-token',
      '?planToken=v1.abc.def&planToken=v1.abc.def',
      '?dryRun=true&planToken=v1.abc.def',
      `?planToken=${'a'.repeat(513)}`,
    ]
  ) {
    const result = parse(query);
    assertEquals(result.mode, 'invalid');
  }
});
