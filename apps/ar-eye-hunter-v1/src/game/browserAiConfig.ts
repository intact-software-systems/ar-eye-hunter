export type ArenaBrowserAiMode = 'mock' | 'off';

export const ARENA_BROWSER_AI_MODE_ENV_KEY = 'VITE_RALLAR_BROWSER_AI';
export const ARENA_BROWSER_AI_ENABLED_ENV_KEY = 'VITE_RALLAR_BROWSER_AI_ENABLED';

export type ArenaBrowserAiEnv = Readonly<Record<string, string | boolean | undefined>>;

export function resolveArenaBrowserAiMode(
    env: ArenaBrowserAiEnv = readImportMetaEnv(),
): ArenaBrowserAiMode {
    const enabled = readBoolLike(env[ARENA_BROWSER_AI_ENABLED_ENV_KEY]);
    if (enabled === false) {
        return 'off';
    }

    const mode = readStringLike(env[ARENA_BROWSER_AI_MODE_ENV_KEY]).toLowerCase();
    if (mode === '0' || mode === 'false' || mode === 'no' || mode === 'off' || mode === 'disabled') {
        return 'off';
    }

    return 'mock';
}

export function isArenaBrowserAiEnabled(env?: ArenaBrowserAiEnv): boolean {
    return resolveArenaBrowserAiMode(env) !== 'off';
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
