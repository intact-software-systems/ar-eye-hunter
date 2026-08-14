import { describe, expect, it, vi } from 'vitest';

import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { WebSocketClientCallbacks } from '@shared/websocket/JsonWebSocketClient.ts';
import { initGroupStateResyncOnReopen } from '@shared-web/browser/state-read/group-state-resync-on-reopen.ts';

describe('group-state resync on WS reopen', () => {
  it('pulls state and topologies on a socket reopen', async () => {
    const socket = createFakeSocket();
    const groups = [{ group: { groupId: 'room-a' } } as GroupSnapshot];
    const resyncStateSnapshots = vi.fn(async () => groups);
    const resyncGroupTopologies = vi.fn(async () => undefined);

    initGroupStateResyncOnReopen({
      socket: socket.asClient(),
      resyncStateSnapshots,
      resyncGroupTopologies,
      isCurrentGeneration: () => true,
    });
    socket.fireOpen();

    await vi.waitFor(() => {
      expect(resyncGroupTopologies).toHaveBeenCalledWith(groups);
    });
    expect(resyncStateSnapshots).toHaveBeenCalledTimes(1);
  });

  it('skips the resync entirely on a stale generation', async () => {
    const socket = createFakeSocket();
    const resyncStateSnapshots = vi.fn(async () => []);
    const resyncGroupTopologies = vi.fn(async () => undefined);

    initGroupStateResyncOnReopen({
      socket: socket.asClient(),
      resyncStateSnapshots,
      resyncGroupTopologies,
      isCurrentGeneration: () => false,
    });
    socket.fireOpen();

    await flushMicrotasks();
    expect(resyncStateSnapshots).not.toHaveBeenCalled();
    expect(resyncGroupTopologies).not.toHaveBeenCalled();
  });

  it('stops before the topology pull when the generation goes stale mid-resync', async () => {
    const socket = createFakeSocket();
    let current = true;
    const resyncStateSnapshots = vi.fn(async () => {
      current = false;
      return [];
    });
    const resyncGroupTopologies = vi.fn(async () => undefined);

    initGroupStateResyncOnReopen({
      socket: socket.asClient(),
      resyncStateSnapshots,
      resyncGroupTopologies,
      isCurrentGeneration: () => current,
    });
    socket.fireOpen();

    await vi.waitFor(() => {
      expect(resyncStateSnapshots).toHaveBeenCalledTimes(1);
    });
    await flushMicrotasks();
    expect(resyncGroupTopologies).not.toHaveBeenCalled();
  });

  it('unregisters its socket callback on stop', () => {
    const socket = createFakeSocket();
    const stop = initGroupStateResyncOnReopen({
      socket: socket.asClient(),
      resyncStateSnapshots: vi.fn(async () => []),
      resyncGroupTopologies: vi.fn(async () => undefined),
      isCurrentGeneration: () => true,
    });

    stop();

    expect(socket.removedIds).toEqual(['rallar:group-state-resync-on-reopen']);
  });

  it('swallows and reports resync failures without an unhandled rejection', async () => {
    const socket = createFakeSocket();
    const resyncStateSnapshots = vi.fn(async () => {
      throw new Error('refresh failed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    initGroupStateResyncOnReopen({
      socket: socket.asClient(),
      resyncStateSnapshots,
      resyncGroupTopologies: vi.fn(async () => undefined),
      isCurrentGeneration: () => true,
    });
    socket.fireOpen();

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    warn.mockRestore();
  });
});

function createFakeSocket() {
  const callbacksById = new Map<string, WebSocketClientCallbacks>();
  const removedIds: string[] = [];
  const client = {
    onWebsocketCallbacksDo(id: string, callbacks: WebSocketClientCallbacks) {
      callbacksById.set(id, callbacks);
      return client;
    },
    removeWebsocketCallbackById(id: string): boolean {
      removedIds.push(id);
      return callbacksById.delete(id);
    },
  };
  return {
    asClient: () => client as never,
    fireOpen: () => {
      for (const callbacks of callbacksById.values()) {
        callbacks.onOpen?.(new Event('open'));
      }
    },
    removedIds,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}
