import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_EXPERIENCE, resolveAppExperience } from '../../../apps/rallar-black-box/src/app/experience-route.ts';

describe('rallar-black-box experience route', () => {
    it.each([
        ['?workspace=black-box-runner', 'workspace'],
        ['?appMode=black-box-runner', 'appMode'],
        ['?tab=fleet', 'tab'],
        ['?advancedSurface=workbench', 'advancedSurface'],
        ['?advanced=workbench', 'advanced']
    ])('keeps the %s compatibility input in the legacy experience', (search) => {
        expect(resolveAppExperience(search)).toBe('legacy');
    });

    it('uses Recipe Console for blank and provider-only URLs', () => {
        expect(DEFAULT_APP_EXPERIENCE).toBe('recipe-console');
        expect(resolveAppExperience('')).toBe('recipe-console');
        expect(resolveAppExperience('?provider=simulated')).toBe('recipe-console');
    });

    it('opts into Recipe Console only for its supported explicit version', () => {
        expect(resolveAppExperience('?experience=recipe-console')).toBe('recipe-console');
        expect(resolveAppExperience('?v=1&experience=recipe-console')).toBe('recipe-console');
        expect(resolveAppExperience('?v=2&experience=recipe-console')).toBe('legacy');
        expect(resolveAppExperience('?v=01&experience=recipe-console')).toBe('legacy');
        expect(resolveAppExperience('?v=1&experience=legacy')).toBe('legacy');
    });

    it.each([
        '?workspace=black-box-runner&tab=fleet&advanced=workbench&experience=recipe-console',
        '?workspace=black-box-runner&tab=fleet&advanced=workbench&v=1&experience=recipe-console',
        '?mode=control-agent&v=1&experience=recipe-console'
    ])('lets a valid explicit experience win over stale legacy aliases: %s', (search) => {
        expect(resolveAppExperience(search)).toBe('recipe-console');
    });

    it('preserves every legacy alias when a future default selects Recipe Console', () => {
        expect(resolveAppExperience('', 'recipe-console')).toBe('recipe-console');
        expect(resolveAppExperience('?workspace=black-box-runner', 'recipe-console')).toBe('legacy');
        expect(resolveAppExperience('?appMode=rallar', 'recipe-console')).toBe('legacy');
        expect(resolveAppExperience('?tab=local-workbench', 'recipe-console')).toBe('legacy');
        expect(resolveAppExperience('?advancedSurface=workbench', 'recipe-console')).toBe('legacy');
        expect(resolveAppExperience('?advanced=workbench', 'recipe-console')).toBe('legacy');
        expect(resolveAppExperience('?v=2&experience=recipe-console', 'recipe-console')).toBe('legacy');
    });

    it.each([
        '?mode=control',
        '?mode=control-agent'
    ])('keeps the legacy %s launch mode under a future default', (search) => {
        expect(resolveAppExperience(search, 'recipe-console')).toBe('legacy');
    });

    it('does not let an invalid explicit experience inherit a future default', () => {
        expect(resolveAppExperience(
            '?experience=Recipe-Console',
            'recipe-console'
        )).toBe('legacy');
        expect(resolveAppExperience(
            '?experience=unknown',
            'recipe-console'
        )).toBe('legacy');
    });

    it('does not mutate legacy runner launch input', () => {
        const launchSearch = '?mode=control&workspace=black-box-runner&tab=local-workbench&roomId=room-a';

        expect(resolveAppExperience(launchSearch)).toBe('legacy');
        expect(launchSearch).toBe(
            '?mode=control&workspace=black-box-runner&tab=local-workbench&roomId=room-a'
        );
    });
});
