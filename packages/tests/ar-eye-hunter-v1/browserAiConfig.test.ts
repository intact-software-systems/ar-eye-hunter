import { describe, expect, it } from 'vitest';

import {
    ARENA_BROWSER_AI_ENABLED_ENV_KEY,
    ARENA_BROWSER_AI_MODE_ENV_KEY,
    ARENA_BROWSER_AI_WEBLLM_FALLBACK_ENV_KEY,
    ARENA_BROWSER_AI_WEBLLM_MODEL_ENV_KEY,
    DEFAULT_ARENA_WEBLLM_MODEL_ID,
    isArenaBrowserAiEnabled,
    resolveArenaBrowserAiConfig,
    resolveArenaBrowserAiMode,
} from '../../../apps/ar-eye-hunter-v1/src/game/browserAiConfig.ts';

describe('AR Eye Hunter browser RallarAI config', () => {
    it('enables browser RallarAI for the Cloudflare production env', () => {
        const env = {
            [ARENA_BROWSER_AI_MODE_ENV_KEY]: 'webllm',
            [ARENA_BROWSER_AI_ENABLED_ENV_KEY]: 'true',
            [ARENA_BROWSER_AI_WEBLLM_MODEL_ENV_KEY]: DEFAULT_ARENA_WEBLLM_MODEL_ID,
        };

        expect(resolveArenaBrowserAiMode(env)).toBe('webllm');
        expect(isArenaBrowserAiEnabled(env)).toBe(true);
        expect(resolveArenaBrowserAiConfig(env)).toEqual({
            enabled: true,
            mode: 'webllm',
            modelId: DEFAULT_ARENA_WEBLLM_MODEL_ID,
            fallbackMode: 'mock',
        });
    });

    it('uses the low-resource WebLLM model and mock fallback by default', () => {
        expect(resolveArenaBrowserAiConfig({})).toEqual({
            enabled: true,
            mode: 'mock',
            modelId: DEFAULT_ARENA_WEBLLM_MODEL_ID,
            fallbackMode: 'mock',
        });
    });

    it('allows WebLLM fallback to be disabled explicitly', () => {
        expect(resolveArenaBrowserAiConfig({
            [ARENA_BROWSER_AI_MODE_ENV_KEY]: 'webllm',
            [ARENA_BROWSER_AI_WEBLLM_FALLBACK_ENV_KEY]: 'off',
        })).toEqual({
            enabled: true,
            mode: 'webllm',
            modelId: DEFAULT_ARENA_WEBLLM_MODEL_ID,
            fallbackMode: 'off',
        });
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
