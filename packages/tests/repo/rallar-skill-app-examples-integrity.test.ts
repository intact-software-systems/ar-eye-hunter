import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

describe('Rallar skill app and example integrity', () => {
  it('provides the greenfield app workflow and audited evidence map', () => {
    const skill = readRepo('.agents/skills/building-rallar-apps/SKILL.md');
    const scaffolding = readRepo(
      '.agents/skills/building-rallar-apps/references/app-scaffolding.md',
    );
    const architecture = readRepo(
      '.agents/skills/building-rallar-apps/references/react-3d-architecture.md',
    );
    const exampleMap = readRepo('.agents/skills/building-rallar-apps/references/example-map.md');
    const messageExample = readRepo('examples/room-message-channel/README.md');
    const realtimeExample = readRepo('examples/room-realtime-channel/README.md');
    const examplesIndex = readRepo('examples/README.md');
    const initialBoot =
      scaffolding.match(/## Initial Boot\n([\s\S]*?)\n## Room-Bound Vertical Slice/)?.[1] ?? '';
    const verticalSlice =
      scaffolding.match(/## Room-Bound Vertical Slice\n([\s\S]*?)\n## Runtime Adapter/)?.[1] ?? '';
    const runtimeAdapter =
      scaffolding.match(/## Runtime Adapter\n([\s\S]*?)\n## React Adapter/)?.[1] ?? '';

    expectAll(skill, [
      '`references/app-scaffolding.md`',
      '`references/react-3d-architecture.md`',
      '`references/example-map.md`',
      'rallar.setup',
      'roomRef',
    ]);
    expectAll(scaffolding, [
      'apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts',
      'rallar.rooms.enter',
      'rallar.rooms.createAndSwitch',
      'AbortController',
    ]);
    expectAll(architecture, [
      'Direct Three.js',
      'React Three Fiber',
      'no per-frame React state',
      'Rallar Motion',
      'dispose',
    ]);
    expectAll(exampleMap, [
      'examples/browser-startup-room',
      'examples/room-message-channel',
      'examples/room-realtime-channel',
      'examples/motion-smoothing',
      'apps/ar-eye-hunter-v1',
      'apps/relic-hunters-v1',
      'projects/cash-chase-arena',
    ]);
    expect
      .soft({
        verticalMessageTargets: verticalSlice.includes('message.raw.targets'),
        verticalMessageGroupRefCheck: verticalSlice.includes('isSameGroupRef'),
        verticalMessageCallbackValidations:
          verticalSlice.match(/isMessageForRoom\(roomRef, message\)/g)?.length === 2,
        scaffoldingRealtimePayloadRoomRef: scaffolding.includes('roomRef: GroupRef'),
        scaffoldingRealtimeGroupRefCheck: scaffolding.includes('message.data.roomRef'),
        messageExampleTargets: messageExample.includes('message.raw.targets'),
        messageExampleGroupRefCheck: messageExample.includes('isSameGroupRef'),
        realtimeExamplePayloadRoomRef: realtimeExample.includes('message.data.roomRef'),
        realtimeExampleGroupRefCheck: realtimeExample.includes('isSameGroupRef'),
        examplesIndexReceiveBoundary: examplesIndex.includes('not automatically room-filtered'),
      })
      .toEqual({
        verticalMessageTargets: true,
        verticalMessageGroupRefCheck: true,
        verticalMessageCallbackValidations: true,
        scaffoldingRealtimePayloadRoomRef: true,
        scaffoldingRealtimeGroupRefCheck: true,
        messageExampleTargets: true,
        messageExampleGroupRefCheck: true,
        realtimeExamplePayloadRoomRef: true,
        realtimeExampleGroupRefCheck: true,
        examplesIndexReceiveBoundary: true,
      });
    expect
      .soft({
        readyResult: scaffolding.includes('const readyResult = await ready.send'),
        poseResult: scaffolding.includes('const poseResult = await poses.send'),
        acceptedMessageStatuses: scaffolding.includes("'sent-immediate'"),
        degradedRealtimeResult: scaffolding.includes("poseResult.status !== 'sent'"),
        messageExampleResult: messageExample.includes('sendResult.status'),
        realtimeExampleResult: realtimeExample.includes("sendResult.status !== 'sent'"),
      })
      .toEqual({
        readyResult: true,
        poseResult: true,
        acceptedMessageStatuses: true,
        degradedRealtimeResult: true,
        messageExampleResult: true,
        realtimeExampleResult: true,
      });
    expect
      .soft({
        viteConfig: scaffolding.includes('vite.config.ts'),
        sharedWebAlias: scaffolding.includes("'@shared-web'"),
        bundlerResolution: scaffolding.includes('"moduleResolution": "Bundler"'),
        strictPort: scaffolding.includes('strictPort: true'),
        websocketProxy: scaffolding.includes('ws: true'),
        appLocalRenderer: scaffolding.includes('app-local renderer dependencies'),
      })
      .toEqual({
        viteConfig: true,
        sharedWebAlias: true,
        bundlerResolution: true,
        strictPort: true,
        websocketProxy: true,
        appLocalRenderer: true,
      });
    expect
      .soft({
        oneAppStartOptions: initialBoot.match(/const appStartOptions/g)?.length === 1,
        posesLaneConfig: initialBoot.includes('const posesLaneConfig'),
        posesLaneId: initialBoot.includes("id: 'poses'"),
        defaultRealtimeLane: initialBoot.includes('DEFAULT_REALTIME_DATA_CHANNEL_LANE'),
        laneBearingStartOptions: initialBoot.includes(
          'dataChannelLanes: [DEFAULT_REALTIME_DATA_CHANNEL_LANE, posesLaneConfig]',
        ),
        setupStartOptions: initialBoot.includes('start: appStartOptions'),
        postLoginStartOptions: initialBoot.includes('rallar.start(appStartOptions)'),
      })
      .toEqual({
        oneAppStartOptions: true,
        posesLaneConfig: true,
        posesLaneId: true,
        defaultRealtimeLane: true,
        laneBearingStartOptions: true,
        setupStartOptions: true,
        postLoginStartOptions: true,
      });
    expect
      .soft({
        runtimeMessageType: runtimeAdapter.includes('RallarMessage'),
        runtimeTargetNarrowing: runtimeAdapter.includes('message.raw.targets'),
        runtimeFullGroupRefCheck: runtimeAdapter.includes('isSameGroupRef'),
        runtimeCallbackValidation: runtimeAdapter.includes(
          'isMessageForRoom(roomSession.roomRef, message)',
        ),
      })
      .toEqual({
        runtimeMessageType: true,
        runtimeTargetNarrowing: true,
        runtimeFullGroupRefCheck: true,
        runtimeCallbackValidation: true,
      });
    expect
      .soft({
        returnsDisposer: verticalSlice.includes('Promise<() => void>'),
        exposesSubscriptionCleanup: verticalSlice.includes(
          'return () => subscriptions.unsubscribe()',
        ),
        capturesDisposer: verticalSlice.includes('const disposeArena = await openArena()'),
        invokesDisposer: verticalSlice.includes('disposeArena()'),
        failureCleansSubscriptions: verticalSlice.includes(
          'catch (error) {\n        subscriptions.unsubscribe();\n        throw error;\n    }',
        ),
      })
      .toEqual({
        returnsDisposer: true,
        exposesSubscriptionCleanup: true,
        capturesDisposer: true,
        invokesDisposer: true,
        failureCleansSubscriptions: true,
      });
  });

  it('keeps current startup and recipe documentation internally consistent', () => {
    const aiSkill = readRepo('docs/rallar-ai-skill.md');
    const prompting = readRepo('docs/rallar-ai-prompting-guide.md');
    const troubleshooting = readRepo('docs/rallar-troubleshooting-checklist.md');
    const quickstart = readRepo('docs/rallar-quickstart-and-recipes.md');
    const aiExample = readRepo('examples/rallar-ai-game-event/README.md');
    const docsIndex = readRepo('docs/README.md');

    expectAll(aiSkill, ['initial app boot', '`rallar.setup(...)`', '`rallar.start(...)`']);
    expectAll(prompting, ['rallar.setup({', 'After login, call rallar.start']);
    expect(troubleshooting).toContain('`rallar.setup(...)`');
    expect
      .soft({
        oneQuickstartSetup: quickstart.match(/rallar\.setup\(setup\)/g)?.length === 1,
        postLoginStart: quickstart.includes('started = await rallar.start(setup.start)'),
      })
      .toEqual({
        oneQuickstartSetup: true,
        postLoginStart: true,
      });
    expect
      .soft({
        standaloneMotionSetup: quickstart.includes('standalone initial setup'),
        sharedMotionStartOptions: quickstart.includes('const motionStartOptions'),
        setupUsesMotionStartOptions: quickstart.includes('start: motionStartOptions'),
        loginUsesMotionStartOptions: quickstart.includes('rallar.start(motionStartOptions)'),
        lanesConfiguredBeforeConnection: quickstart.includes('dataChannelLanes'),
      })
      .toEqual({
        standaloneMotionSetup: true,
        sharedMotionStartOptions: true,
        setupUsesMotionStartOptions: true,
        loginUsesMotionStartOptions: true,
        lanesConfiguredBeforeConnection: true,
      });
    expect(quickstart).not.toContain('motionLane.send(');
    expectAll(quickstart, [
      'const motionUpdates = room.realtime<PoseUpdate>',
      'await motionUpdates.send(nextPose)',
    ]);
    expect(aiExample).toContain("import { rallar } from '@shared-web/browser/rallar.ts';");
    expect(docsIndex).toContain('./rallar-api-v1-in-memory-performance-mode.md');
    expect(docsIndex).not.toContain(
      '../iterations/completed/rallar-api-v1-in-memory-sql-performance-mode.md',
    );
    expect(
      existsSync(path.join(repoRoot, 'docs/rallar-api-v1-in-memory-performance-mode.md')),
    ).toBe(true);
  });

  it('does not expose root commands or project references for removed apps', () => {
    const packageJson = readJson('package.json') as { scripts?: Record<string, string> };
    const tsconfig = readJson('tsconfig.json') as {
      references?: readonly { path?: string }[];
    };

    expect(packageJson.scripts).not.toHaveProperty('dev:web');
    expect(packageJson.scripts).not.toHaveProperty('build:web');
    expect(packageJson.scripts).not.toHaveProperty('dev:api');
    for (const command of Object.values(packageJson.scripts ?? {})) {
      expect(command).not.toContain('apps/web');
      expect(command).not.toMatch(/\bapps\/api(?:\s|$)/);
    }
    expect(tsconfig.references?.map((reference) => reference.path)).not.toContain('apps/web');
  });
});

function readRepo(filePath: string): string {
  return readAbsolute(path.join(repoRoot, filePath));
}

function readAbsolute(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

function readJson(filePath: string): unknown {
  return JSON.parse(readRepo(filePath));
}

function expectAll(haystack: string, needles: readonly string[]): void {
  for (const needle of needles) {
    expect(haystack, needle).toContain(needle);
  }
}

function expectAllNormalized(haystack: string, needles: readonly string[]): void {
  const normalized = normalizeWhitespace(haystack);
  for (const needle of needles) {
    expect(normalized, needle).toContain(normalizeWhitespace(needle));
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
