import { describe, expect, it } from 'vitest';

import {
    ARENA_BROWSER_AI_ENABLED_ENV_KEY,
    ARENA_BROWSER_AI_MODE_ENV_KEY,
    isArenaBrowserAiEnabled,
    resolveArenaBrowserAiMode,
} from '../../../apps/ar-eye-hunter-v1/src/game/browserAiConfig.ts';

describe('AR Eye Hunter browser RallarAI config', () => {
    it('enables browser RallarAI for the Cloudflare production env', () => {
        const env = {
            [ARENA_BROWSER_AI_MODE_ENV_KEY]: 'mock',
            [ARENA_BROWSER_AI_ENABLED_ENV_KEY]: 'true',
        };

        expect(resolveArenaBrowserAiMode(env)).toBe('mock');
        expect(isArenaBrowserAiEnabled(env)).toBe(true);
    });

    it('keeps browser RallarAI enabled by default unless explicitly disabled', () => {
        expect(resolveArenaBrowserAiMode({})).toBe('mock');
        expect(isArenaBrowserAiEnabled({
            [ARENA_BROWSER_AI_ENABLED_ENV_KEY]: 'false',
            [ARENA_BROWSER_AI_MODE_ENV_KEY]: 'mock',
        })).toBe(false);
        expect(isArenaBrowserAiEnabled({
            [ARENA_BROWSER_AI_MODE_ENV_KEY]: 'off',
        })).toBe(false);
    });
});
