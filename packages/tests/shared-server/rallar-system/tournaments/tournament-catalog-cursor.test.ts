import { TournamentCatalogCursor } from '@shared-server/rallar-system/tournaments/catalog/tournament-catalog-cursor.ts';
import { decodeBase64Url, toBase64Url } from '@shared/encoding/base64url.ts';
import { describe, expect, it } from 'vitest';

const request = { scope: { applicationId: 'game', workspaceId: 'default' }, principalId: 'alice', view: 'mine' as const, limit: 20, cursor: null };
const afterKey = 'app=game:ws=default:tournament=undisclosed-private-bracket';

describe('confidential account-scoped tournament continuations', () => {
    it('resumes on another server with the same configured key and permits page-size changes', async () => {
        const writer = new TournamentCatalogCursor('test-only-stable-server-secret');
        const reader = new TournamentCatalogCursor('test-only-stable-server-secret');
        const token = await writer.encode(request, afterKey);
        expect(new TextDecoder().decode(decodeBase64Url(token).right!)).not.toContain('undisclosed-private-bracket');
        expect(await reader.decode({ ...request, limit: 50, cursor: token })).toBe(afterKey);
        expect(await writer.encode(request, afterKey)).not.toBe(token);
    });

    it('rejects tampering, wrong keys and replay under another account, workspace or view', async () => {
        const owner = new TournamentCatalogCursor('test-only-stable-server-secret');
        const token = await owner.encode(request, afterKey);
        const corrupted = decodeBase64Url(token).right!;
        corrupted[corrupted.length - 1] ^= 1;
        await expect(owner.decode({ ...request, cursor: toBase64Url(corrupted) })).rejects.toBeInstanceOf(TypeError);
        await expect(new TournamentCatalogCursor('changed-key').decode({ ...request, cursor: token })).rejects.toBeInstanceOf(TypeError);
        await expect(owner.decode({ ...request, principalId: 'bob', cursor: token })).rejects.toBeInstanceOf(TypeError);
        await expect(owner.decode({ ...request, scope: { ...request.scope, workspaceId: 'other' }, cursor: token })).rejects.toBeInstanceOf(TypeError);
        await expect(owner.decode({ ...request, view: 'public', cursor: token })).rejects.toBeInstanceOf(TypeError);
    });

    it('rejects malformed continuations and canonical keys without accepting an older cleartext format', async () => {
        const owner = new TournamentCatalogCursor('test-only-stable-server-secret');
        expect(await owner.decode(request)).toBeUndefined();
        for (const token of ['', '!bad', 'a'.repeat(4097), toBase64Url(new TextEncoder().encode(JSON.stringify({ ...request, afterKey })))]) {
            await expect(owner.decode({ ...request, cursor: token })).rejects.toBeInstanceOf(TypeError);
        }
        await expect(owner.encode(request, 'app=other:ws=default:tournament=private')).rejects.toThrow();
        expect(() => new TournamentCatalogCursor('')).toThrow();
    });
});
