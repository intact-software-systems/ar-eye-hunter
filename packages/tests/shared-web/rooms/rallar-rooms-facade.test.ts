import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from '@babel/parser';
import { expect, expectTypeOf, it } from 'vitest';

import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import { createRallarRoomsFacade as createCompatibilityRallarRoomsFacade } from '@shared-web/browser/rallar-rooms-facade.ts';
import type * as CompatibilityRoomSurface from '@shared-web/browser/rallar-rooms-facade.ts';
import type {
  RallarRoomPresenceWaitResult,
  RallarRoomSession,
  RallarRoomState,
  RallarRoomSummary,
  RallarRoomsFacade,
} from '@shared-web/browser/rallar-rooms-facade.ts';
import type {
  RallarReplayEventsResult,
  RallarUnsubscribe,
} from '@shared-web/browser/rallar-shared-contracts.ts';
import type * as OwningRoomContracts from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import { createBrowserRallarRooms } from '@shared-web/browser/rooms/browser-rallar-rooms.ts';
import { createRallarRoomsFacade as createOwningRallarRoomsFacade } from '@shared-web/browser/rooms/rallar-rooms-facade.ts';
import type * as OwningRoomFacade from '@shared-web/browser/rooms/rallar-rooms-facade.ts';

const ROOM_CONTRACT_EXPORT_NAMES = [
  'RallarRoomSummary',
  'RallarRoomMember',
  'RallarRoomState',
  'RallarRoomPresenceWaitOptions',
  'RallarRoomPresenceWaitResult',
  'RallarCreateRoomInput',
  'RallarRoomTargetInput',
  'RallarUpdateRoomInput',
  'RallarRoomLifecycleOptions',
  'RallarRoomInviteOptions',
  'RallarRoomGovernanceOptions',
  'RallarJoinRoomOptions',
  'RallarJoinRoomInput',
  'RallarRoomSwitchOperation',
  'RallarRoomSwitchPartialFailureError',
  'RallarLeaveRoomOptions',
  'RallarRoomEventOptions',
  'RallarListRoomEventsOptions',
  'RallarListRoomEventsInput',
  'RallarReplayRoomEventsOptions',
  'RallarReplayRoomEventsInput',
  'RallarRoomEventListener',
  'RallarRoomSessionRealtimeInput',
  'RallarRoomSessionMessageDefinition',
  'RallarRoomSession',
] as const;

const ROOM_FACADE_TYPE_EXPORT_NAMES = [
  'CreateRallarRoomsFacadeOptions',
  'RallarRoomsFacade',
] as const;

interface CompatibilityRoomContracts {
  readonly summary: CompatibilityRoomSurface.RallarRoomSummary;
  readonly member: CompatibilityRoomSurface.RallarRoomMember;
  readonly state: CompatibilityRoomSurface.RallarRoomState;
  readonly presenceWaitOptions: CompatibilityRoomSurface.RallarRoomPresenceWaitOptions;
  readonly presenceWaitResult: CompatibilityRoomSurface.RallarRoomPresenceWaitResult;
  readonly createInput: CompatibilityRoomSurface.RallarCreateRoomInput;
  readonly targetInput: CompatibilityRoomSurface.RallarRoomTargetInput;
  readonly updateInput: CompatibilityRoomSurface.RallarUpdateRoomInput;
  readonly lifecycleOptions: CompatibilityRoomSurface.RallarRoomLifecycleOptions;
  readonly inviteOptions: CompatibilityRoomSurface.RallarRoomInviteOptions;
  readonly governanceOptions: CompatibilityRoomSurface.RallarRoomGovernanceOptions;
  readonly joinOptions: CompatibilityRoomSurface.RallarJoinRoomOptions;
  readonly joinInput: CompatibilityRoomSurface.RallarJoinRoomInput;
  readonly switchOperation: CompatibilityRoomSurface.RallarRoomSwitchOperation;
  readonly switchError: CompatibilityRoomSurface.RallarRoomSwitchPartialFailureError;
  readonly leaveOptions: CompatibilityRoomSurface.RallarLeaveRoomOptions;
  readonly eventOptions: CompatibilityRoomSurface.RallarRoomEventOptions;
  readonly listEventsOptions: CompatibilityRoomSurface.RallarListRoomEventsOptions;
  readonly listEventsInput: CompatibilityRoomSurface.RallarListRoomEventsInput;
  readonly replayEventsOptions: CompatibilityRoomSurface.RallarReplayRoomEventsOptions;
  readonly replayEventsInput: CompatibilityRoomSurface.RallarReplayRoomEventsInput;
  readonly eventListener: CompatibilityRoomSurface.RallarRoomEventListener;
  readonly sessionRealtimeInput: CompatibilityRoomSurface.RallarRoomSessionRealtimeInput;
  readonly sessionMessageDefinition: CompatibilityRoomSurface.RallarRoomSessionMessageDefinition;
  readonly session: CompatibilityRoomSurface.RallarRoomSession;
}

interface OwningContracts {
  readonly summary: OwningRoomContracts.RallarRoomSummary;
  readonly member: OwningRoomContracts.RallarRoomMember;
  readonly state: OwningRoomContracts.RallarRoomState;
  readonly presenceWaitOptions: OwningRoomContracts.RallarRoomPresenceWaitOptions;
  readonly presenceWaitResult: OwningRoomContracts.RallarRoomPresenceWaitResult;
  readonly createInput: OwningRoomContracts.RallarCreateRoomInput;
  readonly targetInput: OwningRoomContracts.RallarRoomTargetInput;
  readonly updateInput: OwningRoomContracts.RallarUpdateRoomInput;
  readonly lifecycleOptions: OwningRoomContracts.RallarRoomLifecycleOptions;
  readonly inviteOptions: OwningRoomContracts.RallarRoomInviteOptions;
  readonly governanceOptions: OwningRoomContracts.RallarRoomGovernanceOptions;
  readonly joinOptions: OwningRoomContracts.RallarJoinRoomOptions;
  readonly joinInput: OwningRoomContracts.RallarJoinRoomInput;
  readonly switchOperation: OwningRoomContracts.RallarRoomSwitchOperation;
  readonly switchError: OwningRoomContracts.RallarRoomSwitchPartialFailureError;
  readonly leaveOptions: OwningRoomContracts.RallarLeaveRoomOptions;
  readonly eventOptions: OwningRoomContracts.RallarRoomEventOptions;
  readonly listEventsOptions: OwningRoomContracts.RallarListRoomEventsOptions;
  readonly listEventsInput: OwningRoomContracts.RallarListRoomEventsInput;
  readonly replayEventsOptions: OwningRoomContracts.RallarReplayRoomEventsOptions;
  readonly replayEventsInput: OwningRoomContracts.RallarReplayRoomEventsInput;
  readonly eventListener: OwningRoomContracts.RallarRoomEventListener;
  readonly sessionRealtimeInput: OwningRoomContracts.RallarRoomSessionRealtimeInput;
  readonly sessionMessageDefinition: OwningRoomContracts.RallarRoomSessionMessageDefinition;
  readonly session: OwningRoomContracts.RallarRoomSession;
}

interface FocusedTypeCheckResult {
  readonly status: number | null;
  readonly version: string;
  readonly diagnostics: string;
}

interface CompatibilityExport {
  readonly exportedName: string;
  readonly typeOnly: boolean;
  readonly specifier?: string;
}

function runFocusedTypeCheck(): FocusedTypeCheckResult {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'rallar-room-facade-types-'));
  const configPath = path.join(temporaryDirectory, 'tsconfig.json');
  const testPath = path.resolve('packages/tests/shared-web/rooms/rallar-rooms-facade.test.ts');
  const compilerPath = path.resolve('node_modules/typescript/bin/tsc');

  writeFileSync(
    configPath,
    JSON.stringify({
      extends: path.resolve('packages/tests/tsconfig.json'),
      compilerOptions: {
        lib: ['ES2023', 'DOM'],
        noEmit: true,
        target: 'ES2023',
        typeRoots: [path.resolve('node_modules/@types'), path.resolve('node_modules')],
      },
      files: [testPath],
      include: [],
    }),
    'utf8',
  );

  try {
    const version = spawnSync(process.execPath, [compilerPath, '--version'], {
      encoding: 'utf8',
    });
    const check = spawnSync(
      process.execPath,
      [compilerPath, '--project', configPath, '--pretty', 'false'],
      { encoding: 'utf8' },
    );
    return {
      status: check.status,
      version: version.stdout.trim(),
      diagnostics: `${check.stdout}${check.stderr}`,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function readCompatibilityExports(): readonly CompatibilityExport[] {
  const source = readFileSync('packages/shared-web/browser/rallar-rooms-facade.ts', 'utf8');
  const statements = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
  }).program.body;

  return statements.flatMap((statement) => {
    if (statement.type !== 'ExportNamedDeclaration') {
      return [];
    }
    return statement.specifiers.flatMap((specifier) => {
      if (specifier.type !== 'ExportSpecifier') {
        return [];
      }
      return [
        {
          exportedName:
            specifier.exported.type === 'Identifier'
              ? specifier.exported.name
              : specifier.exported.value,
          typeOnly: statement.exportKind === 'type' || specifier.exportKind === 'type',
          specifier: statement.source?.value,
        },
      ];
    });
  });
}

it('type-checks the owning and compatibility room surfaces with TypeScript 7.0.2', () => {
  const result = runFocusedTypeCheck();

  expect(result.version).toBe('Version 7.0.2');
  expect(result.status, result.diagnostics).toBe(0);
  expect(result.diagnostics).toBe('');
});

it('exposes the browser room feature entry', () => {
  expect(typeof createBrowserRallarRooms).toBe('function');
});

it('retains the current public facade return types through the existing path', () => {
  expectTypeOf<RallarRoomsFacade['state']>().returns.toEqualTypeOf<RallarRoomState>();
  expectTypeOf<RallarRoomsFacade['list']>().returns.toEqualTypeOf<readonly RallarRoomSummary[]>();
  expectTypeOf<RallarRoomsFacade['refresh']>().returns.toEqualTypeOf<Promise<RallarRoomState>>();
  expectTypeOf<RallarRoomsFacade['listEvents']>().returns.toEqualTypeOf<
    Promise<readonly GroupEvent[]>
  >();
  expectTypeOf<RallarRoomsFacade['listEventPage']>().returns.toEqualTypeOf<
    Promise<StateEventPage<GroupEvent>>
  >();
  expectTypeOf<RallarRoomsFacade['replayEvents']>().returns.toEqualTypeOf<
    Promise<RallarReplayEventsResult<GroupEvent>>
  >();
  expectTypeOf<RallarRoomsFacade['create']>().returns.toEqualTypeOf<Promise<GroupSnapshot>>();
  expectTypeOf<RallarRoomsFacade['createAndSwitch']>().returns.toEqualTypeOf<
    Promise<GroupSnapshot>
  >();
  expectTypeOf<RallarRoomsFacade['join']>().returns.toEqualTypeOf<Promise<GroupSnapshot>>();
  expectTypeOf<RallarRoomsFacade['enter']>().returns.toEqualTypeOf<Promise<RallarRoomSession>>();
  expectTypeOf<RallarRoomsFacade['session']>().returns.toEqualTypeOf<RallarRoomSession>();
  expectTypeOf<RallarRoomsFacade['leave']>().returns.toEqualTypeOf<
    Promise<GroupSnapshot | undefined>
  >();
  expectTypeOf<RallarRoomsFacade['waitForPresence']>().returns.toEqualTypeOf<
    Promise<RallarRoomPresenceWaitResult>
  >();
  expectTypeOf<RallarRoomsFacade['current']>().returns.toEqualTypeOf<GroupSnapshot | undefined>();
  expectTypeOf<RallarRoomsFacade['onChange']>().returns.toEqualTypeOf<RallarUnsubscribe>();
  expectTypeOf<RallarRoomsFacade['onEvent']>().returns.toEqualTypeOf<RallarUnsubscribe>();
});

it('exposes the existing room facade surface through the owning paths', () => {
  expect(createOwningRallarRoomsFacade).toBe(createCompatibilityRallarRoomsFacade);
  expectTypeOf<OwningRoomFacade.RallarRoomsFacade>().toEqualTypeOf<CompatibilityRoomSurface.RallarRoomsFacade>();
  expectTypeOf<OwningRoomFacade.CreateRallarRoomsFacadeOptions>().toEqualTypeOf<CompatibilityRoomSurface.CreateRallarRoomsFacadeOptions>();
  expectTypeOf<OwningContracts>().toEqualTypeOf<CompatibilityRoomContracts>();
});

it('keeps the compatibility module at exactly 28 explicit exports', () => {
  const exports = readCompatibilityExports();
  const contractExports = exports.filter(
    (entry) => entry.specifier === '@shared-web/browser/rooms/rallar-room-contracts.ts',
  );
  const facadeExports = exports.filter(
    (entry) => entry.specifier === '@shared-web/browser/rooms/rallar-rooms-facade.ts',
  );

  expect(exports).toHaveLength(28);
  expect(contractExports.map((entry) => entry.exportedName)).toEqual(ROOM_CONTRACT_EXPORT_NAMES);
  expect(contractExports.every((entry) => entry.typeOnly)).toBe(true);
  expect(
    facadeExports.filter((entry) => entry.typeOnly).map((entry) => entry.exportedName),
  ).toEqual(ROOM_FACADE_TYPE_EXPORT_NAMES);
  expect(
    facadeExports.filter((entry) => !entry.typeOnly).map((entry) => entry.exportedName),
  ).toEqual(['createRallarRoomsFacade']);
});
