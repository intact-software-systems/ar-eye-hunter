import { test } from 'bun:test';

import assert from 'node:assert/strict';

import { createRetentionPlanTokenAdapter } from '../src/retention-plan-token.ts';

const KEY_A = new Uint8Array(32).fill(0x11);
const KEY_B = new Uint8Array(32).fill(0x22);

test('retention plan tokens are bounded process-bound and consequence-bound', async () => {
    let nowEpochMs = 1_000;
    const adapter = createRetentionPlanTokenAdapter({
        key: KEY_A,
        now: () => nowEpochMs,
        ttlMs: 5_000,
        subtle: crypto.subtle
    });
    const otherProcess = createRetentionPlanTokenAdapter({
        key: KEY_B,
        now: () => nowEpochMs,
        ttlMs: 5_000,
        subtle: crypto.subtle
    });

    const token = await adapter.issue('candidate-content-a');

    assert.ok(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token));
    assert.ok(token.length <= 512);
    assert.deepEqual(await adapter.verify(token, 'candidate-content-a'), true);
    assert.deepEqual(await adapter.verify(token, 'candidate-content-b'), false);
    assert.deepEqual(await otherProcess.verify(token, 'candidate-content-a'), false);

    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    assert.deepEqual(await adapter.verify(tampered, 'candidate-content-a'), false);

    nowEpochMs = 6_001;
    assert.deepEqual(await adapter.verify(token, 'candidate-content-a'), false);
});

test('retention plan token verification rejects malformed and oversized values', async () => {
    const adapter = createRetentionPlanTokenAdapter({
        key: KEY_A,
        now: () => 10_000,
        ttlMs: 1_000,
        subtle: crypto.subtle
    });

    for (
        const token of [
            '',
            'v2.abc.def',
            'v1',
            'v1.abc',
            'v1.abc.def.extra',
            'v1.@@@.def',
            `v1.${'a'.repeat(513)}.def`
        ]
    ) {
        assert.deepEqual(await adapter.verify(token, 'candidate-content'), false);
    }
});

test('retention plan token verification rejects noncanonical equivalent signatures', async () => {
    const adapter = createRetentionPlanTokenAdapter({
        key: KEY_A,
        now: () => 10_000,
        ttlMs: 1_000,
        subtle: crypto.subtle
    });
    const token = await adapter.issue('candidate-content');
    const segments = token.split('.');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const signature = segments[2]!;
    const canonicalIndex = alphabet.indexOf(signature.at(-1)!);
    assert.deepEqual(canonicalIndex & 0b11, 0);
    const equivalentLast = alphabet[canonicalIndex | 0b01]!;
    const noncanonical = `${segments[0]}.${segments[1]}.${signature.slice(0, -1)}${equivalentLast}`;

    assert.ok(noncanonical !== token);
    assert.deepEqual(await adapter.verify(noncanonical, 'candidate-content'), false);
});

test('retention plan token verification accepts only the unpadded base64url form of a 32-byte signature', async () => {
    const adapter = createRetentionPlanTokenAdapter({
        key: KEY_A,
        now: () => 10_000,
        ttlMs: 1_000,
        subtle: crypto.subtle
    });
    const token = await adapter.issue('candidate-content');
    const [version, expiry, signature] = token.split('.');
    const standard = signature!.replaceAll('-', '+').replaceAll('_', '/');

    assert.deepEqual(signature!.length, 43);
    assert.deepEqual(await adapter.verify(token, 'candidate-content'), true);
    for (
        const candidate of [
            `${signature}=`,
            standard === signature ? `${signature!.slice(0, -1)}+` : standard,
            `${signature!.slice(0, -1)}*`,
            '',
            signature!.slice(0, -2),
            `${signature}AAAA`
        ]
    ) {
        assert.deepEqual(await adapter.verify(`${version}.${expiry}.${candidate}`, 'candidate-content'), false);
    }
});

test('retention plan token verification rechecks expiry after async crypto', async () => {
    let nowEpochMs = 1_000;
    const delegate = crypto.subtle;
    const subtle = {
        importKey: delegate.importKey.bind(delegate),
        sign: delegate.sign.bind(delegate),
        async verify(...args: Parameters<SubtleCrypto['verify']>) {
            const verified = await delegate.verify(...args);
            nowEpochMs = 6_001;
            return verified;
        }
    };
    const adapter = createRetentionPlanTokenAdapter({
        key: KEY_A,
        now: () => nowEpochMs,
        ttlMs: 5_000,
        subtle
    });

    const token = await adapter.issue('candidate-content');
    assert.deepEqual(await adapter.verify(token, 'candidate-content'), false);
});
