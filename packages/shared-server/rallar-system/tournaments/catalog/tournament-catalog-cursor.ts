import { requireExactKeys, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import { decodeBase64Url, toBase64Url } from '@shared/encoding/base64url.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { decodeTournamentStorageKey } from '../tournament-storage-key.ts';
import type { TournamentCatalogReader } from './tournament-catalog-reader.ts';

export function toTournamentCatalogCursor(request: TournamentCatalogReader.Request, afterKey: string): string {
    return toBase64Url(
        new TextEncoder().encode(
            JSON.stringify({ scope: request.scope, principalId: request.principalId, view: request.view, afterKey })
        )
    );
}

export function decodeTournamentCatalogCursor(request: TournamentCatalogReader.Request): string | undefined {
    if (request.cursor === null) {
        return undefined;
    }
    if (request.cursor.length > 4096) {
        throw new TypeError('Tournament continuation exceeds its bound');
    }
    const bytes = decodeBase64Url(request.cursor).right;
    if (bytes === undefined) {
        throw new TypeError('Tournament continuation is invalid');
    }
    const cursor = requireRecord(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        'Tournament continuation'
    );
    requireExactKeys(cursor, ['scope', 'principalId', 'view', 'afterKey'], 'Tournament continuation');
    if (
        !jsonEquals(cursor.scope, request.scope) || cursor.principalId !== request.principalId ||
        cursor.view !== request.view
    ) {
        throw new TypeError('Tournament continuation belongs to another scope, account or view');
    }
    requireString(cursor.afterKey, 'Tournament continuation key');
    decodeTournamentStorageKey(cursor.afterKey, request.scope);
    return cursor.afterKey;
}
