import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from '@babel/parser';
import { expect, expectTypeOf, it, vi } from 'vitest';

import type { GroupEvent, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import { createRallarRoomsFacade as createCompatibilityRallarRoomsFacade } from '@shared-web/browser/rallar-rooms-facade.ts';
import type * as CompatibilityRoomSurface from '@shared-web/browser/rallar-rooms-facade.ts';
import type {
  RallarRoomPresenceWaitResult,
  RallarRoomEventListener,
  RallarRoomSession,
  RallarRoomState,
  RallarRoomSummary,
  RallarRoomsFacade,
} from '@shared-web/browser/rallar-rooms-facade.ts';
import type {
  RallarReplayEventsResult,
  RallarStateListener,
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

function assertReadonlyRoomMethods(facade: RallarRoomsFacade, session: RallarRoomSession): void {
  // @ts-expect-error Public facade methods remain readonly.
  facade.refresh = facade.refresh;
  // @ts-expect-error Public room-session methods remain readonly.
  session.refresh = session.refresh;
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
        target: 'ES2023',
        typeRoots: [path.resolve('node_modules/@types'), path.resolve('node_modules')],
      },
      files: [testPath],
      include: [],
    }),
    'utf8',
  );
  try {
    const textOutput = { encoding: 'utf8' } as const;
    const version = spawnSync(process.execPath, [compilerPath, '--version'], textOutput);
    const check = spawnSync(
      process.execPath,
      [compilerPath, '--project', configPath, '--pretty', 'false'],
      textOutput,
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
  const statements = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program.body;
  return statements.flatMap((statement) =>
    statement.type === 'ExportNamedDeclaration'
      ? statement.specifiers.flatMap((specifier) =>
          specifier.type === 'ExportSpecifier'
            ? [
                {
                  exportedName:
                    'name' in specifier.exported
                      ? specifier.exported.name
                      : specifier.exported.value,
                  typeOnly: statement.exportKind === 'type' || specifier.exportKind === 'type',
                  specifier: statement.source?.value,
                },
              ]
            : [],
        )
      : [],
  );
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

it('delegates room methods through injected operations', async () => {
  const roomRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1',
  } satisfies GroupRef;
  const snapshot = { group: roomRef } as GroupSnapshot;
  const state = {
    rooms: [],
    currentRoomId: 'room-1',
    currentRoomRef: roomRef,
    currentRoom: snapshot,
    members: [],
  } satisfies RallarRoomState;
  const event = {} as GroupEvent;
  const page = { events: [event], hasMore: false } as unknown as StateEventPage<GroupEvent>;
  const replay = {
    events: [event],
    hasMore: false,
    pageCount: 1,
    replayedCount: 1,
    duplicateCount: 0,
  } satisfies RallarReplayEventsResult<GroupEvent>;
  const unsubscribe = vi.fn();
  const stateListener = vi.fn() as RallarStateListener<RallarRoomState>;
  const eventListener = vi.fn() as RallarRoomEventListener;
  const memberId = 'member-1';
  const timeoutOptions = { timeoutMs: 25 };
  const metadataPatch = { topic: 'maps' };
  const expectedTimeout = { timeoutMs: 25 };
  const expectedPatch = { topic: 'maps' };
  const operations = {
    state: vi.fn(() => state),
    list: vi.fn(() => state.rooms),
    refresh: vi.fn(async () => state),
    listEvents: vi.fn(async () => [event]),
    listEventPage: vi.fn(async () => page),
    replayEvents: vi.fn(async () => replay),
    create: vi.fn(async () => snapshot),
    createAndSwitch: vi.fn(async () => snapshot),
    join: vi.fn(async () => snapshot),
    enter: vi.fn(async () => ({ roomId: 'room-1', roomRef }) as never),
    session: vi.fn(() => ({ roomId: 'room-1', roomRef }) as never),
    leave: vi.fn(async () => snapshot),
    update: vi.fn(async () => snapshot),
    archive: vi.fn(async () => snapshot),
    delete: vi.fn(async () => snapshot),
    invite: vi.fn(async () => snapshot),
    acceptInvite: vi.fn(async () => snapshot),
    removeMember: vi.fn(async () => snapshot),
    banMember: vi.fn(async () => snapshot),
    unbanMember: vi.fn(async () => snapshot),
    setMemberRole: vi.fn(async () => snapshot),
    transferOwnership: vi.fn(async () => snapshot),
    updateMetadata: vi.fn(async () => snapshot),
    waitForPresence: vi.fn(async () => undefined as never),
    current: vi.fn(() => snapshot),
    onChange: vi.fn(() => unsubscribe),
    onEvent: vi.fn(() => unsubscribe),
  };
  const facade = createCompatibilityRallarRoomsFacade(operations);

  expect(facade.state()).toBe(state);
  expect(facade.list()).toBe(state.rooms);
  await expect(
    facade.refresh({ applicationId: 'app-1', workspaceId: 'workspace-1' }),
  ).resolves.toBe(state);
  await expect(facade.listEvents('room-1')).resolves.toEqual([event]);
  await expect(facade.listEventPage({ roomRef, limit: 1 })).resolves.toBe(page);
  await expect(facade.replayEvents({ roomRef, maxPages: 1 }, eventListener)).resolves.toBe(replay);
  await expect(facade.create('Room 1')).resolves.toBe(snapshot);
  await expect(facade.createAndSwitch('Room 2')).resolves.toBe(snapshot);
  await expect(facade.join(roomRef, { leaveCurrent: false })).resolves.toBe(snapshot);
  await expect(facade.enter(roomRef, { leaveCurrent: false })).resolves.toMatchObject({
    roomId: 'room-1',
  });
  expect(facade.session(roomRef)).toMatchObject({ roomId: 'room-1' });
  await expect(facade.leave({ roomRef })).resolves.toBe(snapshot);
  await expect(facade.update({ roomRef, displayName: 'Renamed Room' })).resolves.toBe(snapshot);
  await expect(facade.archive(roomRef, timeoutOptions)).resolves.toBe(snapshot);
  await expect(facade.delete(roomRef, timeoutOptions)).resolves.toBe(snapshot);
  await expect(
    facade.invite(roomRef, memberId, { invitationExpiresAtEpochMs: 2_000 }),
  ).resolves.toBe(snapshot);
  await expect(facade.acceptInvite(roomRef, timeoutOptions)).resolves.toBe(snapshot);
  await expect(facade.removeMember(roomRef, memberId, timeoutOptions)).resolves.toBe(snapshot);
  await expect(facade.banMember(roomRef, memberId, timeoutOptions)).resolves.toBe(snapshot);
  await expect(facade.unbanMember(roomRef, memberId, timeoutOptions)).resolves.toBe(snapshot);
  await expect(facade.setMemberRole(roomRef, memberId, 'admin', timeoutOptions)).resolves.toBe(
    snapshot,
  );
  await expect(facade.transferOwnership(roomRef, memberId, timeoutOptions)).resolves.toBe(snapshot);
  await expect(facade.updateMetadata(roomRef, metadataPatch, timeoutOptions)).resolves.toBe(
    snapshot,
  );
  expect(facade.current()).toBe(snapshot);
  expect(facade.onChange(stateListener, { emitCurrent: false })).toBe(unsubscribe);
  expect(facade.onEvent(eventListener, { roomRef })).toBe(unsubscribe);

  expect(operations.refresh).toHaveBeenCalledWith({
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
  });
  expect(operations.listEvents).toHaveBeenCalledWith('room-1');
  expect(operations.listEventPage).toHaveBeenCalledWith({ roomRef, limit: 1 });
  expect(operations.replayEvents).toHaveBeenCalledWith({ roomRef, maxPages: 1 }, eventListener);
  expect(operations.create).toHaveBeenCalledWith('Room 1');
  expect(operations.createAndSwitch).toHaveBeenCalledWith('Room 2');
  expect(operations.join).toHaveBeenCalledWith(roomRef, { leaveCurrent: false });
  expect(operations.enter).toHaveBeenCalledWith(roomRef, { leaveCurrent: false });
  expect(operations.session).toHaveBeenCalledWith(roomRef);
  expect(operations.leave).toHaveBeenCalledWith({ roomRef });
  expect(operations.update).toHaveBeenCalledWith({ roomRef, displayName: 'Renamed Room' });
  expect(operations.archive).toHaveBeenCalledWith(roomRef, expectedTimeout);
  expect(operations.delete).toHaveBeenCalledWith(roomRef, expectedTimeout);
  expect(operations.invite).toHaveBeenCalledWith(roomRef, memberId, {
    invitationExpiresAtEpochMs: 2_000,
  });
  expect(operations.acceptInvite).toHaveBeenCalledWith(roomRef, expectedTimeout);
  expect(operations.removeMember).toHaveBeenCalledWith(roomRef, memberId, expectedTimeout);
  expect(operations.banMember).toHaveBeenCalledWith(roomRef, memberId, expectedTimeout);
  expect(operations.unbanMember).toHaveBeenCalledWith(roomRef, memberId, expectedTimeout);
  expect(operations.setMemberRole).toHaveBeenCalledWith(
    roomRef,
    memberId,
    'admin',
    expectedTimeout,
  );
  expect(operations.transferOwnership).toHaveBeenCalledWith(roomRef, memberId, expectedTimeout);
  expect(operations.updateMetadata).toHaveBeenCalledWith(roomRef, expectedPatch, expectedTimeout);
  expect(operations.onChange).toHaveBeenCalledWith(stateListener, { emitCurrent: false });
  expect(operations.onEvent).toHaveBeenCalledWith(eventListener, { roomRef });
});
