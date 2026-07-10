import { createRetentionPlanTokenAdapter } from '../src/retention-plan-token.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected, null, 2)}, got ${JSON.stringify(actual, null, 2)}`,
    );
  }
}

const KEY_A = new Uint8Array(32).fill(0x11);
const KEY_B = new Uint8Array(32).fill(0x22);

Deno.test('retention plan tokens are bounded process-bound and consequence-bound', async () => {
  let nowEpochMs = 1_000;
  const adapter = createRetentionPlanTokenAdapter({
    key: KEY_A,
    now: () => nowEpochMs,
    ttlMs: 5_000,
  });
  const otherProcess = createRetentionPlanTokenAdapter({
    key: KEY_B,
    now: () => nowEpochMs,
    ttlMs: 5_000,
  });

  const token = await adapter.issue('candidate-content-a');

  assert(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token));
  assert(token.length <= 512);
  assertEquals(await adapter.verify(token, 'candidate-content-a'), true);
  assertEquals(await adapter.verify(token, 'candidate-content-b'), false);
  assertEquals(await otherProcess.verify(token, 'candidate-content-a'), false);

  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  assertEquals(await adapter.verify(tampered, 'candidate-content-a'), false);

  nowEpochMs = 6_001;
  assertEquals(await adapter.verify(token, 'candidate-content-a'), false);
});

Deno.test('retention plan token verification rejects malformed and oversized values', async () => {
  const adapter = createRetentionPlanTokenAdapter({
    key: KEY_A,
    now: () => 10_000,
    ttlMs: 1_000,
  });

  for (
    const token of [
      '',
      'v2.abc.def',
      'v1',
      'v1.abc',
      'v1.abc.def.extra',
      'v1.@@@.def',
      `v1.${'a'.repeat(513)}.def`,
    ]
  ) {
    assertEquals(await adapter.verify(token, 'candidate-content'), false);
  }
});

Deno.test('retention plan token verification rejects noncanonical equivalent signatures', async () => {
  const adapter = createRetentionPlanTokenAdapter({
    key: KEY_A,
    now: () => 10_000,
    ttlMs: 1_000,
  });
  const token = await adapter.issue('candidate-content');
  const segments = token.split('.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const signature = segments[2]!;
  const canonicalIndex = alphabet.indexOf(signature.at(-1)!);
  assertEquals(canonicalIndex & 0b11, 0);
  const equivalentLast = alphabet[canonicalIndex | 0b01]!;
  const noncanonical = `${segments[0]}.${segments[1]}.${signature.slice(0, -1)}${equivalentLast}`;

  assert(noncanonical !== token);
  assertEquals(await adapter.verify(noncanonical, 'candidate-content'), false);
});

Deno.test('retention plan token verification rechecks expiry after async crypto', async () => {
  let nowEpochMs = 1_000;
  const delegate = crypto.subtle;
  const subtle = {
    importKey: delegate.importKey.bind(delegate),
    sign: delegate.sign.bind(delegate),
    async verify(...args: Parameters<SubtleCrypto['verify']>) {
      const verified = await delegate.verify(...args);
      nowEpochMs = 6_001;
      return verified;
    },
  };
  const adapter = createRetentionPlanTokenAdapter({
    key: KEY_A,
    now: () => nowEpochMs,
    ttlMs: 5_000,
    subtle,
  });

  const token = await adapter.issue('candidate-content');
  assertEquals(await adapter.verify(token, 'candidate-content'), false);
});
