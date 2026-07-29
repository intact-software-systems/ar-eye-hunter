import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarRoomStateStorePort } from '@shared-web/browser/rallar-runtime/contracts.ts';
import { normalizeWaitTimeoutMs } from '@shared-web/browser/rallar-runtime/wait.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import {
  evaluateRallarReadinessExpectation,
  normalizeRallarReadinessExpectation,
  type RallarNormalizedReadinessExpectation,
  type RallarReadinessStatus,
} from '@shared-web/browser/readiness.ts';
import { isGroupActive } from '@shared/api/group-client-views.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import type {
  RallarRoomPresenceWaitOptions,
  RallarRoomPresenceWaitResult,
} from './rallar-room-contracts.ts';

export interface WaitForRoomPresenceInput {
  readonly room: string | GroupRef;
  readonly options?: RallarRoomPresenceWaitOptions;
  readonly stateStore: RallarRoomStateStorePort;
  readonly resolveOperationOptions: <T extends RallarOperationOptions>(
    options: T,
  ) => T & RallarOperationOptions;
  readonly resolveRoomRef: (
    room: string | GroupRef,
    scope?: RallarRoomPresenceWaitOptions['scope'],
  ) => GroupRef | undefined;
  readonly onCacheChange: (listener: () => void | Promise<void>) => RallarUnsubscribe;
}

interface CreateRoomPresenceResultReaderInput {
  readonly stateStore: RallarRoomStateStorePort;
  readonly room: string | GroupRef;
  readonly roomId: string;
  readonly roomRef: GroupRef | undefined;
  readonly expectation: RallarNormalizedReadinessExpectation;
}

interface WaitForRoomPresenceChangeInput {
  readonly operationOptions: RallarOperationOptions;
  readonly timeoutMs: number;
  readonly readResult: RoomPresenceResultReader;
  readonly onCacheChange: WaitForRoomPresenceInput['onCacheChange'];
}

type RoomPresenceResultReader = (
  statusOverride?: RallarReadinessStatus,
) => RallarRoomPresenceWaitResult;

export async function waitForRoomPresence(
  input: WaitForRoomPresenceInput,
): Promise<RallarRoomPresenceWaitResult> {
  const options = input.options ?? {};
  const operationOptions = input.resolveOperationOptions(options);
  const roomId = typeof input.room === 'string' ? input.room : input.room.groupId;
  const roomRef = input.resolveRoomRef(input.room, options.scope);
  const expectation = normalizeRallarReadinessExpectation(options.expect);
  const readResult = createRoomPresenceResultReader({
    stateStore: input.stateStore,
    room: input.room,
    roomId,
    roomRef,
    expectation,
  });
  const current = readResult();
  if (isTerminalReadinessWaitResult(current)) {
    return current;
  }
  if (operationOptions.signal?.aborted) {
    return { ...current, status: 'aborted' };
  }
  const timeoutMs = normalizeWaitTimeoutMs(options.timeoutMs);
  if (timeoutMs <= 0) {
    return readResult('timeout');
  }
  return await waitForRoomPresenceChange({
    operationOptions,
    timeoutMs,
    readResult,
    onCacheChange: input.onCacheChange,
  });
}

function createRoomPresenceResultReader(
  input: CreateRoomPresenceResultReaderInput,
): RoomPresenceResultReader {
  return (statusOverride?: RallarReadinessStatus): RallarRoomPresenceWaitResult => {
    const snapshot = input.stateStore.findGroupSnapshot(input.roomRef ?? input.room);
    if (!snapshot || !isGroupActive(snapshot)) {
      return {
        ...evaluateRallarReadinessExpectation([], input.expectation),
        status: statusOverride ?? 'not-found',
        roomId: input.roomId,
        roomRef: input.roomRef,
        activeSessionIds: [],
        timedOut: statusOverride === 'timeout',
      };
    }
    const activeSessionIds = uniquePeerIds(
      snapshot.activeSessions.map((session) => session.sessionId),
    );
    const evaluation = evaluateRallarReadinessExpectation(activeSessionIds, input.expectation);
    return {
      ...evaluation,
      status: statusOverride ?? evaluation.status,
      roomId: input.roomId,
      roomRef: snapshot.group,
      activeSessionIds,
      timedOut: statusOverride === 'timeout',
    };
  };
}

async function waitForRoomPresenceChange(
  input: WaitForRoomPresenceChangeInput,
): Promise<RallarRoomPresenceWaitResult> {
  return await new Promise<RallarRoomPresenceWaitResult>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: RallarUnsubscribe = () => {};
    const finish = (result: RallarRoomPresenceWaitResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      input.operationOptions.signal?.removeEventListener('abort', onAbort);
      unsubscribe();
      resolve(result);
    };
    const onAbort = (): void => finish({ ...input.readResult(), status: 'aborted' });
    unsubscribe = input.onCacheChange(() => {
      const next = input.readResult();
      if (isTerminalReadinessWaitResult(next)) {
        finish(next);
      }
    });
    input.operationOptions.signal?.addEventListener('abort', onAbort, { once: true });
    const next = input.readResult();
    if (isTerminalReadinessWaitResult(next)) {
      finish(next);
      return;
    }
    if (input.operationOptions.signal?.aborted) {
      onAbort();
      return;
    }
    timeout = setTimeout(() => finish(input.readResult('timeout')), input.timeoutMs);
  });
}

function uniquePeerIds(peerIds: readonly string[]): readonly string[] {
  return [...new Set(peerIds)];
}

function isTerminalReadinessWaitResult(result: RallarRoomPresenceWaitResult): boolean {
  return result.status === 'ready' || result.status === 'not-found';
}
