import { RALLAR_BLACK_BOX_TEST_COMMAND_KINDS } from './types.ts';

export type RallarCompanionCoverageLayer =
    | 'black-box-runner'
    | 'rallar-bb-test'
    | 'shared-web-facade'
    | 'shared-server-application'
    | 'app-specific';

export interface RallarCompanionCoverageSurface {
    readonly surfaceId: string;
    readonly layer: RallarCompanionCoverageLayer;
    readonly intent: string;
    readonly testFiles: readonly string[];
    readonly runnerBoundary: string;
}

export const RALLAR_BLACK_BOX_RUNNER_STEP_FAMILIES = [
    'HTTP',
    'WS',
    'RTC',
    'ASSERT',
    'SET',
    'PARALLEL'
] as const;

export const RALLAR_FACADE_METHODS_NOT_RECIPE_COMMANDS = [
    'auth.login',
    'auth.register',
    'auth.registerAndLogin',
    'auth.logout',
    'auth.restore',
    'auth.onChange',
    'rooms.create',
    'rooms.join',
    'rooms.leave',
    'rooms.updateMetadata',
    'rooms.refresh',
    'rooms.onChange',
    'rooms.onEvent',
    'rooms.listEvents',
    'rooms.listEventPage',
    'rooms.replayEvents',
    'people.refresh',
    'people.onChange',
    'people.onEvent',
    'people.listEvents',
    'people.listEventPage',
    'people.replayEvents',
    'channels.targeted',
    'channels.room',
    'messages.rtc.send',
    'messages.ws.send',
    'messages.channel',
    'messages.room',
    'realtime.sendJson',
    'realtime.sendBinary',
    'realtime.json',
    'realtime.room',
    'rtc.waitForOpen',
    'rtc.waitForRoomLane',
    'rtc.roomStatus',
    'rtc.openRoom',
    'rtc.waitForRoom',
    'calls.start',
    'calls.invite',
    'calls.onInvite',
    'calls.onSignal',
    'director.createRelay',
    'director.onStatus',
    'data.open',
    'media.microphone.start',
    'media.camera.start',
    'media.screen.start',
    'media.setLocalStream',
    'media.setAudioEnabled',
    'media.setVideoEnabled',
    'media.stopLocal'
] as const;

export const RALLAR_COMPANION_COVERAGE_SURFACES: readonly RallarCompanionCoverageSurface[] = [
    {
        surfaceId: 'browser-auth-and-session',
        layer: 'shared-web-facade',
        intent: 'Direct browser facade auth/session behavior, defaults, restore, and start flows.',
        testFiles: [
            'packages/tests/shared-web/rallar-auth-session-contract.test.ts',
            'packages/tests/shared-web/rallar-startup-lifecycle.test.ts',
            'packages/tests/rallar-black-box/auth-flow.test.ts',
            'packages/tests/shared-test/rallar-bb-browser-adapter-auth.test.ts'
        ],
        runnerBoundary: 'Use HTTP steps for observable auth endpoints; do not add auth.* recipe commands.'
    },
    {
        surfaceId: 'browser-room-and-people-facades',
        layer: 'shared-web-facade',
        intent: 'Direct facade room, people, state refresh, event history, replay, and subscription behavior.',
        testFiles: [
            'packages/tests/shared-web/rooms/room-state-store.test.ts',
            'packages/tests/shared-web/rooms/room-state-store-current-room.test.ts',
            'packages/tests/shared-web/rooms/room-events-list-and-page.test.ts',
            'packages/tests/shared-web/rooms/room-events-replay.test.ts',
            'packages/tests/shared-web/rooms/room-events-subscription.test.ts',
            'packages/tests/shared-web/people/people-events.test.ts'
        ],
        runnerBoundary: 'Use REST/WS observations for room membership; do not add rooms.* or people.* recipe commands.'
    },
    {
        surfaceId: 'browser-message-and-realtime-facades',
        layer: 'shared-web-facade',
        intent: 'Typed message channels, realtime lanes, RTC waits, and facade default propagation.',
        testFiles: [
            'packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts',
            'packages/tests/shared-web/messages/browser-typed-message-channels.test.ts',
            'packages/tests/shared-web/realtime/browser-realtime-send-receive.test.ts',
            'packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts',
            'packages/tests/shared-web/realtime/browser-realtime-json-lane.test.ts',
            'packages/tests/shared-web/rtc/browser-rtc-wait-runtime.test.ts',
            'packages/tests/shared-web/realtime/browser-targeted-realtime-runtime.test.ts',
            'packages/tests/shared-web/calls/rallar-calls.test.ts',
            'packages/tests/shared-web/media/browser-media-sources.test.ts',
            'packages/tests/shared-web/rallar-flow.test.ts'
        ],
        runnerBoundary:
            'Use RTC/WS send and wait steps for delivery observations; provider adapters may call facade methods internally.'
    },
    {
        surfaceId: 'browser-data-facade',
        layer: 'shared-web-facade',
        intent: 'Rallar Data repository behavior, persistence, synchronization, and browser storage semantics.',
        testFiles: ['packages/tests/shared-web/rallar-data.test.ts'],
        runnerBoundary: 'Keep data API parity in package or app tests unless it is visible as HTTP/WS/RTC traffic.'
    },
    {
        surfaceId: 'server-application-and-websocket-router',
        layer: 'shared-server-application',
        intent: 'Server application behavior for application data and REST, plus WebSocket topic routing.',
        testFiles: [
            'packages/tests/shared-server/app-data/rallar-server-app-data.test.ts',
            'packages/tests/shared-server/rallar-server/rallar-server-application.test.ts',
            'packages/tests/shared-server/rallar-system/rallar-server-ws-router.test.ts'
        ],
        runnerBoundary:
            'Black-box recipes call public REST/WS endpoints; they do not expose server application or router methods.'
    },
    {
        surfaceId: 'remote-browser-command-bridge',
        layer: 'rallar-bb-test',
        intent: 'Visible or remote browser control through portable commands and event/result normalization.',
        testFiles: [
            'packages/tests/shared-test/rallar-bb-test.test.ts',
            'packages/tests/shared-test/rallar-bb-test-composite-conformance.test.ts',
            'packages/tests/shared-test/rallar-provider-parity.test.ts',
            'packages/tests/shared-test/rallar-remote-browser-provider.test.ts'
        ],
        runnerBoundary:
            'Bridge commands stay narrow: configure, recipe, composite loop/parallel orchestration, wait-for-evidence, assert-evidence, HTTP, WS, RTC, CRDT handles, appointed director relay probes, health, stats, close, and reset.'
    },
    {
        surfaceId: 'black-box-network-recipes',
        layer: 'black-box-runner',
        intent: 'External HTTP, WS, RTC, ASSERT, and SET recipe execution plus reports and artifacts.',
        testFiles: [
            'packages/tests/shared-test/scenario-black-box-config.test.ts',
            'packages/tests/shared-test/scenario-black-box-rtc-config.test.ts',
            'packages/tests/shared-test/execute-black-box.test.ts'
        ],
        runnerBoundary: 'Runner steps describe observable network calls and expectations only.'
    },
    {
        surfaceId: 'app-specific-data-media-behavior',
        layer: 'app-specific',
        intent: 'Product workflows that need browser APIs, UI state, media devices, or app-specific orchestration.',
        testFiles: [
            'packages/tests/rallar-black-box/browser-rallar-runtime.test.ts',
            'packages/tests/rallar-black-box/rtc-diagnostics.test.ts',
            'tests/playwright/rallar-black-box'
        ],
        runnerBoundary:
            'Use app tests or browser harnesses for UI/data/media behavior that is not just network observation.'
    }
] as const;

export function rallarCompanionCoverageBySurface(
    surfaceId: string
): RallarCompanionCoverageSurface | undefined {
    return RALLAR_COMPANION_COVERAGE_SURFACES.find(
        (surface) => surface.surfaceId === surfaceId
    );
}

export function rallarBlackBoxCommandKinds(): readonly string[] {
    return RALLAR_BLACK_BOX_TEST_COMMAND_KINDS;
}
