import { RALLAR_BLACK_BOX_TEST_COMMAND_KINDS } from './types.ts';

export type RallarCompanionCoverageLayer =
    | 'black-box-runner'
    | 'rallar-bb-test'
    | 'shared-web-facade'
    | 'shared-server-facade'
    | 'app-specific';

export type RallarCompanionCoverageSurface = Readonly<{
    surfaceId: string;
    layer: RallarCompanionCoverageLayer;
    intent: string;
    testFiles: readonly string[];
    runnerBoundary: string;
}>;

export const RALLAR_BLACK_BOX_RUNNER_STEP_FAMILIES = [
    'HTTP',
    'WS',
    'RTC',
    'ASSERT',
    'SET',
] as const;

export const RALLAR_FACADE_METHODS_NOT_RECIPE_COMMANDS = [
    'auth.login',
    'auth.register',
    'auth.registerAndLogin',
    'auth.logout',
    'rooms.create',
    'rooms.join',
    'rooms.leave',
    'rooms.refresh',
    'people.refresh',
    'messages.rtc.send',
    'messages.ws.send',
    'messages.channel',
    'realtime.sendJson',
    'rtc.waitForOpen',
    'director.createRelay',
    'director.onStatus',
    'data.open',
    'media.start',
] as const;

export const RALLAR_COMPANION_COVERAGE_SURFACES: readonly RallarCompanionCoverageSurface[] = [
    {
        surfaceId: 'browser-auth-and-session',
        layer: 'shared-web-facade',
        intent: 'Direct browser facade auth/session behavior, defaults, restore, and start flows.',
        testFiles: [
            'packages/tests/shared-web/rallar-operation-options.test.ts',
            'packages/tests/rallar-black-box/auth-flow.test.ts',
            'packages/tests/shared-test/rallar-bb-browser-adapter-auth.test.ts',
        ],
        runnerBoundary: 'Use HTTP steps for observable auth endpoints; do not add auth.* recipe commands.',
    },
    {
        surfaceId: 'browser-room-and-people-facades',
        layer: 'shared-web-facade',
        intent: 'Direct facade room, people, state refresh, event history, replay, and subscription behavior.',
        testFiles: [
            'packages/tests/shared-web/rallar-operation-options.test.ts',
        ],
        runnerBoundary: 'Use REST/WS observations for room membership; do not add rooms.* or people.* recipe commands.',
    },
    {
        surfaceId: 'browser-message-and-realtime-facades',
        layer: 'shared-web-facade',
        intent: 'Typed message channels, realtime lanes, RTC waits, and facade default propagation.',
        testFiles: [
            'packages/tests/shared-web/rallar-operation-options.test.ts',
            'packages/tests/shared-web/rallar-flow.test.ts',
        ],
        runnerBoundary: 'Use RTC/WS send and wait steps for delivery observations; provider adapters may call facade methods internally.',
    },
    {
        surfaceId: 'browser-data-facade',
        layer: 'shared-web-facade',
        intent: 'Rallar Data repository behavior, persistence, synchronization, and browser storage semantics.',
        testFiles: [
            'packages/tests/shared-web/rallar-data.test.ts',
        ],
        runnerBoundary: 'Keep data API parity in package or app tests unless it is visible as HTTP/WS/RTC traffic.',
    },
    {
        surfaceId: 'server-rest-and-ws-facades',
        layer: 'shared-server-facade',
        intent: 'Server facade behavior for application data, REST, and WebSocket topic routing.',
        testFiles: [
            'packages/tests/shared-server/rallar-server-app-data.test.ts',
            'packages/tests/shared-server/rallar-server-application.test.ts',
            'packages/tests/api-v1/rallar-server-ws-facade.test.ts',
        ],
        runnerBoundary: 'Black-box recipes call public REST/WS endpoints; they do not expose server facade methods.',
    },
    {
        surfaceId: 'remote-browser-command-bridge',
        layer: 'rallar-bb-test',
        intent: 'Visible or remote browser control through portable commands and event/result normalization.',
        testFiles: [
            'packages/tests/shared-test/rallar-bb-test.test.ts',
            'packages/tests/shared-test/rallar-bb-test-composite-conformance.test.ts',
            'packages/tests/shared-test/rallar-provider-parity.test.ts',
            'packages/tests/shared-test/rallar-remote-browser-provider.test.ts',
        ],
        runnerBoundary: 'Bridge commands stay narrow: configure, recipe, composite loop/parallel orchestration, wait-for-evidence, assert-evidence, HTTP, WS, RTC, CRDT handles, appointed director relay probes, health, stats, close, and reset.',
    },
    {
        surfaceId: 'black-box-network-recipes',
        layer: 'black-box-runner',
        intent: 'External HTTP, WS, RTC, ASSERT, and SET recipe execution plus reports and artifacts.',
        testFiles: [
            'packages/tests/shared-test/scenario-black-box-config.test.ts',
            'packages/tests/shared-test/scenario-black-box-rtc-config.test.ts',
            'packages/tests/shared-test/execute-black-box.test.ts',
        ],
        runnerBoundary: 'Runner steps describe observable network calls and expectations only.',
    },
    {
        surfaceId: 'app-specific-data-media-behavior',
        layer: 'app-specific',
        intent: 'Product workflows that need browser APIs, UI state, media devices, or app-specific orchestration.',
        testFiles: [
            'packages/tests/rallar-black-box/browser-rallar-runtime.test.ts',
            'packages/tests/rallar-black-box/rtc-diagnostics.test.ts',
            'tests/playwright/rallar-black-box',
        ],
        runnerBoundary: 'Use app tests or browser harnesses for UI/data/media behavior that is not just network observation.',
    },
] as const;

export function rallarCompanionCoverageBySurface(
    surfaceId: string,
): RallarCompanionCoverageSurface | undefined {
    return RALLAR_COMPANION_COVERAGE_SURFACES.find(surface => surface.surfaceId === surfaceId);
}

export function rallarBlackBoxCommandKinds(): readonly string[] {
    return RALLAR_BLACK_BOX_TEST_COMMAND_KINDS;
}
