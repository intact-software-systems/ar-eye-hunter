import { afterEach, describe, expect, it, vi } from 'vitest';

import { Either } from '@shared/resilience/Either.ts';
import type { SigningKeyPair } from '@shared/signature/ecdsa-p256-signature.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';
import type { PublicationKeyStoreFailure } from '@shared/signature/publication-key-store.ts';
import { readOrCreatePublicationCrypto } from '@shared/signature/read-or-create-publication-crypto.ts';

import { InMemoryPublicationKeyStore } from './publication-key-store-fixtures.ts';

const subtle = globalThis.crypto.subtle;
const STORAGE_FAILED = { kind: 'storage-failed', detail: 'quota exceeded' } as const;

describe('the session publication key, read or created', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('gives every page of one session the pair the first page stored', async () => {
        const store = new InMemoryPublicationKeyStore();
        const warnings = captureWarnings();

        const first = await readOrCreatePublicationCrypto({ subtle, store, sessionId: 'session-1' });
        const second = await readOrCreatePublicationCrypto({ subtle, store, sessionId: 'session-1' });

        expect(readKeyId(first)).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(readKeyId(second)).toBe(readKeyId(first));
        expect(store.pairs.get('session-1')?.keyId).toBe(readKeyId(first));
        expect(first.kind === 'available' && first.keyPair.privateKey.extractable).toBe(false);
        expect(warnings).toStrictEqual([]);
    });

    it('converges two pages that find no stored pair at once on the pair stored first', async () => {
        const store = new InMemoryPublicationKeyStore();

        const [first, second] = await Promise.all([
            readOrCreatePublicationCrypto({ subtle, store, sessionId: 'session-1' }),
            readOrCreatePublicationCrypto({ subtle, store, sessionId: 'session-1' })
        ]);

        expect(readKeyId(second)).toBe(readKeyId(first));
        expect(readKeyId(first)).toBe(store.pairs.get('session-1')?.keyId);
    });

    it('creates another pair for another session and leaves the first session\'s stored', async () => {
        const store = new InMemoryPublicationKeyStore();

        const first = await readOrCreatePublicationCrypto({ subtle, store, sessionId: 'session-1' });
        const next = await readOrCreatePublicationCrypto({ subtle, store, sessionId: 'session-2' });

        expect(readKeyId(next)).not.toBe(readKeyId(first));
        expect([...store.pairs.keys()]).toStrictEqual(['session-1', 'session-2']);
    });

    it.each(['read', 'write'] as const)(
        'keeps a page-local pair and warns once when the store fails to %s',
        async (operation) => {
            const store = new InMemoryPublicationKeyStore({ [operation]: STORAGE_FAILED });
            const warnings = captureWarnings();

            const crypto = await readOrCreatePublicationCrypto({ subtle, store, sessionId: 'session-1' });

            expect(crypto.kind).toBe('available');
            expect(readKeyId(crypto)).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(store.pairs.size).toBe(0);
            expect(warnings).toStrictEqual([[
                'Publication key storage-failed: quota exceeded; this page signs with a key of its own.'
            ]]);
        }
    );

    it.each([
        ['fails', Either.ofLeft<PublicationKeyStoreFailure, SigningKeyPair | null>(STORAGE_FAILED), 'storage-failed: quota exceeded'],
        ['finds no pair', Either.ofRight<PublicationKeyStoreFailure, SigningKeyPair | null>(null), 'storage-failed: no pair was read back after it was stored']
    ])('keeps a page-local pair and warns once when the read after a stored write %s', async (_label, readBack, warning) => {
        const store = new InMemoryPublicationKeyStore();
        vi.spyOn(store, 'read').mockResolvedValueOnce(Either.ofRight(null)).mockResolvedValueOnce(readBack);
        const warnings = captureWarnings();

        const crypto = await readOrCreatePublicationCrypto({ subtle, store, sessionId: 'session-1' });

        expect(readKeyId(crypto)).toBe(store.pairs.get('session-1')?.keyId);
        expect(warnings).toStrictEqual([[`Publication key ${warning}; this page signs with a key of its own.`]]);
    });

    it('leaves a page without SubtleCrypto keyless, warns once, and stores nothing', async () => {
        const store = new InMemoryPublicationKeyStore();
        const warnings = captureWarnings();

        await expect(readOrCreatePublicationCrypto({ subtle: undefined, store, sessionId: 'session-1' })).resolves
            .toStrictEqual({ kind: 'unavailable', reason: 'subtle-unavailable' });

        expect(store.pairs.size).toBe(0);
        expect(warnings).toStrictEqual([['Publication signing is unavailable: subtle-unavailable.']]);
    });

    it('leaves a page whose SubtleCrypto refuses key generation keyless and stores nothing', async () => {
        const store = new InMemoryPublicationKeyStore();
        vi.spyOn(subtle, 'generateKey').mockRejectedValueOnce(new Error('refused'));
        const warnings = captureWarnings();

        await expect(readOrCreatePublicationCrypto({ subtle, store, sessionId: 'session-1' })).resolves
            .toStrictEqual({ kind: 'unavailable', reason: 'key-generation-failed' });

        expect(store.pairs.size).toBe(0);
        expect(warnings).toStrictEqual([['Publication signing is unavailable: key-generation-failed.']]);
    });
});

function readKeyId(crypto: PublicationCrypto): string | undefined {
    return crypto.kind === 'available' ? crypto.keyPair.keyId : undefined;
}

function captureWarnings(): string[][] {
    const warnings: string[][] = [];
    vi.spyOn(console, 'warn').mockImplementation((...messages: string[]) => {
        warnings.push(messages);
    });
    return warnings;
}
