import { decodeBase64Url, toBase64Url } from '@shared/encoding/base64url.ts';
import { decodeTournamentStorageKey } from '../tournament-storage-key.ts';
import type { TournamentCatalogReader } from './tournament-catalog-reader.ts';

const PURPOSE = 'rallar:tournament-catalog:continuation';

/** Confidential continuations must not disclose the identity of the last filtered-out bracket. */
export class TournamentCatalogCursor {
    private readonly key: Promise<CryptoKey>;

    constructor(secret: string) {
        if (secret.length === 0) {
            throw new TypeError('Tournament continuations require the configured server secret');
        }
        this.key = createCursorKey(secret);
    }

    async encode(request: TournamentCatalogReader.Request, afterKey: string): Promise<string> {
        decodeTournamentStorageKey(afterKey, request.scope);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, additionalData: toCursorContext(request) },
            await this.key,
            new TextEncoder().encode(afterKey)
        );
        return toBase64Url(new Uint8Array([...iv, ...new Uint8Array(ciphertext)]));
    }

    async decode(request: TournamentCatalogReader.Request): Promise<string | undefined> {
        if (request.cursor === null) {
            return undefined;
        }
        if (request.cursor.length > 4096) {
            throw new TypeError('Tournament continuation exceeds its bound');
        }
        const bytes = decodeBase64Url(request.cursor).right;
        if (bytes === undefined || bytes.length <= 28) {
            throw new TypeError('Tournament continuation is invalid');
        }
        try {
            const plaintext = await crypto.subtle.decrypt(
                {
                    name: 'AES-GCM',
                    iv: Uint8Array.from(bytes.subarray(0, 12)),
                    additionalData: toCursorContext(request)
                },
                await this.key,
                Uint8Array.from(bytes.subarray(12))
            );
            const afterKey = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
            decodeTournamentStorageKey(afterKey, request.scope);
            return afterKey;
        }
        catch {
            throw new TypeError(
                'Tournament continuation is invalid for this account, scope or view; refresh the catalogue'
            );
        }
    }
}

function toCursorContext(request: TournamentCatalogReader.Request): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(JSON.stringify([
        PURPOSE,
        request.scope.applicationId,
        request.scope.workspaceId,
        request.principalId,
        request.view
    ]));
}

async function createCursorKey(secret: string): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, [
        'deriveKey'
    ]);
    return await crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new TextEncoder().encode(PURPOSE),
            info: new TextEncoder().encode('AES-GCM-256')
        },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}
