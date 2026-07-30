import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
      'PARALLEL',
    ]);
  });

  it('keeps rallar-bb-test command kinds as a bridge surface, not facade methods', () => {
    expect(RALLAR_BLACK_BOX_TEST_COMMAND_KINDS).toEqual([
      'configure',
      'recipe.load',
      'recipe.run',
      'recipe.cancel',
      'loop',
      'parallel',
      'wait',
      'assert',
      'rtc.connect',
      'rtc.send',
      'rtc.stream',
      'ws.open',
      'ws.send',
      'ws.close',
      'http.request',
      'crdt.open',
      'crdt.apply',
      'crdt.read',
      'crdt.sync',
      'crdt.health',
      'crdt.wait',
      'crdt.undo',
      'crdt.redo',
      'crdt.close',
      'crdt.destroy',
      'director.appoint',
      'director.resign',
      'director.status',
      'director.relay.start',
      'director.intent',
      'director.sync.request',
      'director.relay.stop',
      'health',
      'stats',
      'close',
      'reset',
    ]);

    RALLAR_FACADE_METHODS_NOT_RECIPE_COMMANDS.forEach((methodName) => {
      expect(RALLAR_BLACK_BOX_TEST_COMMAND_KINDS).not.toContain(methodName);
    });
  });

  it('names current browser facade helpers that stay outside recipe commands', () => {
    expect(RALLAR_FACADE_METHODS_NOT_RECIPE_COMMANDS).toEqual(
      expect.arrayContaining([
        'messages.room',
        'realtime.room',
        'calls.start',
        'calls.invite',
        'calls.onInvite',
        'calls.onSignal',
        'rooms.onEvent',
        'rooms.listEvents',
        'rooms.listEventPage',
        'rooms.replayEvents',
        'people.onEvent',
        'people.listEvents',
        'people.listEventPage',
        'people.replayEvents',
        'media.microphone.start',
        'media.camera.start',
        'media.screen.start',
      ]),
    );
    expect(RALLAR_FACADE_METHODS_NOT_RECIPE_COMMANDS).not.toContain('media.start');
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

    expect(RALLAR_COMPANION_COVERAGE_SURFACES.map((surface) => surface.surfaceId)).toEqual(
      expectedSurfaces,
    );

    expectedSurfaces.forEach((surfaceId) => {
      const surface = rallarCompanionCoverageBySurface(surfaceId);
      expect(surface).toBeDefined();
      expect(surface?.intent.length).toBeGreaterThan(0);
      expect(surface?.runnerBoundary.length).toBeGreaterThan(0);
      expect(surface?.testFiles.length).toBeGreaterThan(0);
    });
  });

  it('keeps every active companion test path resolvable from the repository root', () => {
    const repositoryRoot = resolve(import.meta.dirname, '../../..');
    const missingTestFiles = RALLAR_COMPANION_COVERAGE_SURFACES.flatMap((surface) =>
      surface.testFiles.filter((testFile) => !existsSync(resolve(repositoryRoot, testFile))),
    );

    expect(missingTestFiles).toEqual([]);
  });

  it('points facade coverage at focused shared-web suites, not the legacy broad suite', () => {
    const auth = rallarCompanionCoverageBySurface('browser-auth-and-session');
    const rooms = rallarCompanionCoverageBySurface('browser-room-and-people-facades');
    const realtime = rallarCompanionCoverageBySurface('browser-message-and-realtime-facades');

    expect(auth?.testFiles).toEqual(
      expect.arrayContaining([
        'packages/tests/shared-web/rallar-auth-facade.test.ts',
        'packages/tests/shared-web/rallar-auth-session-compat.test.ts',
        'packages/tests/shared-web/rallar-startup-lifecycle.test.ts',
      ]),
    );
    expect(rooms?.testFiles).toEqual([
      'packages/tests/shared-web/rooms/rallar-rooms-facade.test.ts',
      'packages/tests/shared-web/rallar-people-facade.test.ts',
      'packages/tests/shared-web/rooms/room-state-store.test.ts',
      'packages/tests/shared-web/rooms/room-state-store-current-room.test.ts',
      'packages/tests/shared-web/people/people-state-compat.test.ts',
      'packages/tests/shared-web/rooms/room-events-list-and-page.test.ts',
      'packages/tests/shared-web/rooms/room-events-replay.test.ts',
      'packages/tests/shared-web/rooms/room-events-subscription.test.ts',
      'packages/tests/shared-web/people/people-events-compat.test.ts',
    ]);
    expect(realtime?.testFiles).toEqual(
      expect.arrayContaining([
        'packages/tests/shared-web/rallar-message-send-compat.test.ts',
        'packages/tests/shared-web/rallar-message-channel-compat.test.ts',
        'packages/tests/shared-web/rallar-realtime-send-listen-compat.test.ts',
        'packages/tests/shared-web/rooms/rallar-room-realtime-channel.test.ts',
        'packages/tests/shared-web/rallar-calls-compat.test.ts',
        'packages/tests/shared-web/rallar-media-facade.test.ts',
        'packages/tests/shared-web/rallar-media-sources-compat.test.ts',
      ]),
    );

    expect(auth?.testFiles).not.toContain(
      'packages/tests/shared-web/rallar-operation-options.test.ts',
    );
    expect(rooms?.testFiles).not.toContain(
      'packages/tests/shared-web/rallar-operation-options.test.ts',
    );
    expect(realtime?.testFiles).not.toContain(
      'packages/tests/shared-web/rallar-operation-options.test.ts',
    );
  });

  it('keeps direct Rallar facade coverage outside the black-box runner layer', () => {
    const directFacadeSurfaces = RALLAR_COMPANION_COVERAGE_SURFACES.filter((surface) =>
      surface.surfaceId.includes('facade'),
    );

    expect(directFacadeSurfaces.length).toBeGreaterThan(0);
    directFacadeSurfaces.forEach((surface) => {
      expect(surface.layer).not.toBe('black-box-runner');
      expect(surface.runnerBoundary).toMatch(/do not|provider adapters|Keep data/i);
    });
  });
});
