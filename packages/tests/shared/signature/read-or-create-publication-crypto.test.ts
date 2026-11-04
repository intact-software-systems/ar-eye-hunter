import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';
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

    it('leaves a page without SubtleCrypto keyless, warns once, and reads no store', async () => {
        const store = new InMemoryPublicationKeyStore();
        const read = vi.spyOn(store, 'read');
        const warnings = captureWarnings();

        await expect(readOrCreatePublicationCrypto({ subtle: undefined, store, sessionId: 'session-1' })).resolves
            .toStrictEqual({ kind: 'unavailable', reason: 'subtle-unavailable' });

        expect(read).not.toHaveBeenCalled();
        expect(warnings).toStrictEqual([['Publication signing is unavailable: subtle-unavailable.']]);
    });

    it('leaves a page whose SubtleCrypto refuses key generation keyless and stores nothing', async () => {
        const store = new InMemoryPublicationKeyStore();
        const refusing = { generateKey: () => Promise.reject(new Error('refused')) } as unknown as SubtleCrypto;
        const warnings = captureWarnings();

        await expect(readOrCreatePublicationCrypto({ subtle: refusing, store, sessionId: 'session-1' })).resolves
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
