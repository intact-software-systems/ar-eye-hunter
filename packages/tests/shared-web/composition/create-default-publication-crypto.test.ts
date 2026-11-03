import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBrowserRuntimeFoundation } from '@shared-web/browser/composition/browser-runtime-composition.ts';
import { createDefaultPublicationCrypto } from '@shared-web/browser/composition/create-default-publication-crypto.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';

describe('the page publication key at the composition root', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('leaves a page without SubtleCrypto keyless and warns once, naming only the failure kind', async () => {
        vi.stubGlobal('crypto', {});
        const warnings = captureWarnings();

        await expect(createDefaultPublicationCrypto()).resolves.toStrictEqual({
            kind: 'unavailable',
            reason: 'subtle-unavailable'
        });

        expect(warnings).toStrictEqual([['Publication signing is unavailable: subtle-unavailable.']]);
    });

    it('creates one non-extractable signing key pair over the page\'s SubtleCrypto without a warning', async () => {
        const warnings = captureWarnings();

        const publicationCrypto = await createDefaultPublicationCrypto();

        expect(publicationCrypto.kind).toBe('available');
        const available = publicationCrypto as Extract<PublicationCrypto, { kind: 'available'; }>;
        expect(available.subtle).toBe(globalThis.crypto.subtle);
        expect(available.keyPair.keyId).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(available.keyPair.publicJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
        expect(available.keyPair.privateKey.extractable).toBe(false);
        expect(warnings).toStrictEqual([]);
    });

    it('gives each foundation its own key, so a reloaded page registers another key id', async () => {
        const first = await createBrowserRuntimeFoundation().publicationCrypto;
        const reloaded = await createBrowserRuntimeFoundation().publicationCrypto;

        expect(first.kind).toBe('available');
        expect(reloaded.kind).toBe('available');
        expect(readKeyId(reloaded)).not.toBe(readKeyId(first));
    });
});

function readKeyId(publicationCrypto: PublicationCrypto): string | undefined {
    return publicationCrypto.kind === 'available' ? publicationCrypto.keyPair.keyId : undefined;
}

function captureWarnings(): string[][] {
    const warnings: string[][] = [];
    vi.spyOn(console, 'warn').mockImplementation((...messages: string[]) => {
        warnings.push(messages);
    });
    return warnings;
}
