import { describe, expect, it } from 'vitest';
import {
    RALLAR_BLACK_BOX_RUNNER_STEP_FAMILIES,
    RALLAR_BLACK_BOX_TEST_COMMAND_KINDS,
    RALLAR_COMPANION_COVERAGE_SURFACES,
    RALLAR_FACADE_METHODS_NOT_RECIPE_COMMANDS,
    rallarCompanionCoverageBySurface,
} from '../../shared-test/rallar-bb-test/mod.ts';

describe('Rallar companion coverage boundaries', () => {
    it('keeps black-box runner step families generic', () => {
        expect(RALLAR_BLACK_BOX_RUNNER_STEP_FAMILIES).toEqual([
            'HTTP',
            'WS',
            'RTC',
            'ASSERT',
            'SET',
        ]);
    });

    it('keeps rallar-bb-test command kinds as a bridge surface, not facade methods', () => {
        expect(RALLAR_BLACK_BOX_TEST_COMMAND_KINDS).toEqual([
            'configure',
            'recipe.load',
            'recipe.run',
            'recipe.cancel',
            'rtc.connect',
            'rtc.send',
            'ws.open',
            'ws.send',
            'ws.close',
            'http.request',
            'health',
            'stats',
            'close',
            'reset',
        ]);

        RALLAR_FACADE_METHODS_NOT_RECIPE_COMMANDS.forEach(methodName => {
            expect(RALLAR_BLACK_BOX_TEST_COMMAND_KINDS).not.toContain(methodName);
        });
    });

    it('maps direct facade surfaces to companion package or app-level tests', () => {
        const expectedSurfaces = [
            'browser-auth-and-session',
            'browser-room-and-people-facades',
            'browser-message-and-realtime-facades',
            'browser-data-facade',
            'server-rest-and-ws-facades',
            'remote-browser-command-bridge',
            'black-box-network-recipes',
            'app-specific-data-media-behavior',
        ];

        expect(RALLAR_COMPANION_COVERAGE_SURFACES.map(surface => surface.surfaceId))
            .toEqual(expectedSurfaces);

        expectedSurfaces.forEach(surfaceId => {
            const surface = rallarCompanionCoverageBySurface(surfaceId);
            expect(surface).toBeDefined();
            expect(surface?.intent.length).toBeGreaterThan(0);
            expect(surface?.runnerBoundary.length).toBeGreaterThan(0);
            expect(surface?.testFiles.length).toBeGreaterThan(0);
        });
    });

    it('keeps direct Rallar facade coverage outside the black-box runner layer', () => {
        const directFacadeSurfaces = RALLAR_COMPANION_COVERAGE_SURFACES
            .filter(surface => surface.surfaceId.includes('facade'));

        expect(directFacadeSurfaces.length).toBeGreaterThan(0);
        directFacadeSurfaces.forEach(surface => {
            expect(surface.layer).not.toBe('black-box-runner');
            expect(surface.runnerBoundary).toMatch(/do not|provider adapters|Keep data/i);
        });
    });
});
