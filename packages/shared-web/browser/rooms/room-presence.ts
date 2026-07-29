import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarRoomStateStorePort } from '@shared-web/browser/rallar-runtime/contracts.ts';
import { normalizeWaitTimeoutMs } from '@shared-web/browser/rallar-runtime/wait.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import {
  evaluateRallarReadinessExpectation,
  normalizeRallarReadinessExpectation,
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

export async function waitForRoomPresence(
  input: WaitForRoomPresenceInput,
): Promise<RallarRoomPresenceWaitResult> {
  const options = input.options ?? {};
  const operationOptions = input.resolveOperationOptions(options);
  const roomId = typeof input.room === 'string' ? input.room : input.room.groupId;
  const roomRef = input.resolveRoomRef(input.room, options.scope);
  const expectation = normalizeRallarReadinessExpectation(options.expect);
  const readResult = (statusOverride?: RallarReadinessStatus): RallarRoomPresenceWaitResult => {
    const snapshot = input.stateStore.findGroupSnapshot(roomRef ?? input.room);
    if (!snapshot || !isGroupActive(snapshot)) {
      return {
        ...evaluateRallarReadinessExpectation([], expectation),
        status: statusOverride ?? 'not-found',
        roomId,
        roomRef,
        activeSessionIds: [],
        timedOut: statusOverride === 'timeout',
      };
    }
    const activeSessionIds = uniquePeerIds(
      snapshot.activeSessions.map((session) => session.sessionId),
    );
    const evaluation = evaluateRallarReadinessExpectation(activeSessionIds, expectation);
    return {
      ...evaluation,
      status: statusOverride ?? evaluation.status,
      roomId,
      roomRef: snapshot.group,
      activeSessionIds,
      timedOut: statusOverride === 'timeout',
    };
  };
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
      operationOptions.signal?.removeEventListener('abort', onAbort);
      unsubscribe();
      resolve(result);
    };
    const onAbort = (): void => finish({ ...readResult(), status: 'aborted' });
    unsubscribe = input.onCacheChange(() => {
      const next = readResult();
      if (isTerminalReadinessWaitResult(next)) {
        finish(next);
      }
    });
    operationOptions.signal?.addEventListener('abort', onAbort, { once: true });
    const next = readResult();
    if (isTerminalReadinessWaitResult(next)) {
      finish(next);
      return;
    }
    if (operationOptions.signal?.aborted) {
      onAbort();
      return;
    }
    timeout = setTimeout(() => finish(readResult('timeout')), timeoutMs);
  });
}

function uniquePeerIds(peerIds: readonly string[]): readonly string[] {
  return [...new Set(peerIds)];
}

function isTerminalReadinessWaitResult(result: RallarRoomPresenceWaitResult): boolean {
  return result.status === 'ready' || result.status === 'not-found';
}
