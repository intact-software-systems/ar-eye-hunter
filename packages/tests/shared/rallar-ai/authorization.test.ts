import {
    assertRallarAiAuthorized
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';

describe('RallarAI authorization', () => {
    it('enforces authorization hooks', async () => {
        await expect(
            assertRallarAiAuthorized(() => false, {
                action: 'generate',
                source: 'server',
                schemaId: 'game-event',
                schemaVersion: '1'
            })
        ).rejects.toThrow('RallarAI action is not authorized');
    });
});
