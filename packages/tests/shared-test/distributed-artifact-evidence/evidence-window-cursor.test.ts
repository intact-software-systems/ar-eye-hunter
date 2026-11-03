import { describe, expect, it } from 'vitest';

import {
    computeEvidenceCursorKey,
    createEvidenceCursor,
    decodeEvidenceCursor
} from '@shared-test/rallar-bb-test/distributed-artifact-evidence/evidence-window-cursor.ts';

const identity = { artifactFingerprint: 'artifact-a', modelFingerprint: 'model-a', instanceId: 'instance-a' };
const position = { queryFingerprint: 'query-a', windowSize: 50, offset: 100 };

describe('evidence window cursor', () => {
    it('decodes the identity, position and 32-byte signature of a cursor it created', async () => {
        const cursor = await createEvidenceCursor(identity, await computeEvidenceCursorKey(identity), position);
        const decoded = decodeEvidenceCursor(cursor);

        expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
        expect(decoded?.identity).toEqual(identity);
        expect(decoded?.position).toEqual(position);
        expect(decoded?.body).toBe(cursor.split('.')[0]);
        expect(decoded?.signature.byteLength).toBe(32);
    });

    it('decodes a bad cursor as undefined', async () => {
        const cursor = await createEvidenceCursor(identity, await computeEvidenceCursorKey(identity), position);
        const [body, signature] = cursor.split('.');

        for (
            const badCursor of [
                'not-a-cursor',
                `${body}.${signature}.extra`,
                `${body}*.${signature}`,
                `${body}.${signature}=`,
                `${body}.${signature?.slice(0, 42)}`,
                `${body}.${signature}A`,
                `${body?.slice(0, -1)}.${signature}`
            ]
        ) {
            expect(decodeEvidenceCursor(badCursor)).toBeUndefined();
        }
    });
});
