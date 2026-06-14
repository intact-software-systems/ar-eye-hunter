export type ArenaBrowserAiMode = 'mock' | 'webllm' | 'off';
export type ArenaBrowserAiFallbackMode = 'mock' | 'off';

export const ARENA_BROWSER_AI_MODE_ENV_KEY = 'VITE_RALLAR_BROWSER_AI';
export const ARENA_BROWSER_AI_ENABLED_ENV_KEY = 'VITE_RALLAR_BROWSER_AI_ENABLED';
export const ARENA_BROWSER_AI_WEBLLM_MODEL_ENV_KEY = 'VITE_RALLAR_WEBLLM_MODEL';
export const ARENA_BROWSER_AI_WEBLLM_FALLBACK_ENV_KEY = 'VITE_RALLAR_WEBLLM_FALLBACK';
export const DEFAULT_ARENA_WEBLLM_MODEL_ID = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

export type ArenaBrowserAiEnv = Readonly<Record<string, string | boolean | undefined>>;
export type ArenaBrowserAiConfig = Readonly<{
    enabled: boolean;
    mode: ArenaBrowserAiMode;
    modelId: string;
    fallbackMode: ArenaBrowserAiFallbackMode;
}>;

export function resolveArenaBrowserAiMode(
    env: ArenaBrowserAiEnv = readImportMetaEnv(),
): ArenaBrowserAiMode {
    return resolveArenaBrowserAiConfig(env).mode;
}

export function resolveArenaBrowserAiConfig(
    env: ArenaBrowserAiEnv = readImportMetaEnv(),
): ArenaBrowserAiConfig {
    const enabled = readBoolLike(env[ARENA_BROWSER_AI_ENABLED_ENV_KEY]);
    const mode = readStringLike(env[ARENA_BROWSER_AI_MODE_ENV_KEY]).toLowerCase();
    const resolvedMode = enabled === false || isDisabledValue(mode)
        ? 'off'
        : mode === 'webllm'
        ? 'webllm'
        : 'mock';
    const fallback = readStringLike(env[ARENA_BROWSER_AI_WEBLLM_FALLBACK_ENV_KEY]).toLowerCase();
    const modelId = readStringLike(env[ARENA_BROWSER_AI_WEBLLM_MODEL_ENV_KEY]) ||
        DEFAULT_ARENA_WEBLLM_MODEL_ID;

    return {
        enabled: resolvedMode !== 'off',
        mode: resolvedMode,
        modelId,
        fallbackMode: isDisabledValue(fallback) ? 'off' : 'mock',
    };
}

export function isArenaBrowserAiEnabled(env?: ArenaBrowserAiEnv): boolean {
    return resolveArenaBrowserAiConfig(env).enabled;
}

function isDisabledValue(value: string): boolean {
    if (!value) {
        return false;
    }
    return value === '0' || value === 'false' || value === 'no' ||
        value === 'off' || value === 'disabled';
}

function readImportMetaEnv(): ArenaBrowserAiEnv {
    return (import.meta as { env?: ArenaBrowserAiEnv }).env ?? {};
}

function readBoolLike(value: string | boolean | undefined): boolean | undefined {
    if (typeof value === 'boolean') {
        return value;
    }
    const normalized = readStringLike(value).toLowerCase();
    if (!normalized) {
        return undefined;
    }
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
        return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
        return false;
    }
    return undefined;
}

function readStringLike(value: string | boolean | undefined): string {
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    return typeof value === 'string' ? value.trim() : '';
}
