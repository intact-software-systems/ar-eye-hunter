export type AppExperience = 'legacy' | 'recipe-console';

export const DEFAULT_APP_EXPERIENCE: AppExperience = 'legacy';

const LEGACY_EXPERIENCE_QUERY_KEYS = [
    'workspace',
    'appMode',
    'tab',
    'advancedSurface',
    'advanced',
] as const;

export function resolveAppExperience(
    search: string,
    defaultExperience: AppExperience = DEFAULT_APP_EXPERIENCE,
): AppExperience {
    const params = new URLSearchParams(search);
    const experience = params.get('experience');
    const version = params.get('v');

    if (experience === 'recipe-console') {
        return version === null || version === '1'
            ? 'recipe-console'
            : 'legacy';
    }
    if (experience !== null || version !== null) {
        return 'legacy';
    }
    if (LEGACY_EXPERIENCE_QUERY_KEYS.some(key => params.has(key))) {
        return 'legacy';
    }
    return defaultExperience;
}
