import type { RallarBlackBoxTestRuntimeEventInput } from '@shared-test/rallar-bb-test/types.ts';
import {
  completedActionFeedback,
  type CommandCenterActionFeedback,
} from '../shared/action-feedback.ts';

type RawWebSocketEventRecorder = (
  topic: string,
  payload: object,
  lastAction: string,
  severity?: RallarBlackBoxTestRuntimeEventInput['severity'],
  kind?: RallarBlackBoxTestRuntimeEventInput['kind'],
) => void;

export function observeRawWebSocket(
  input: Readonly<{
    socket: WebSocket;
    connection: string;
    url: string;
    label: string;
    startedAtEpochMs: number;
    recordEvent: RawWebSocketEventRecorder;
    setWaitStatus: (status: string) => void;
    setActionFeedback: (feedback: CommandCenterActionFeedback) => void;
  }>,
): void {
  input.socket.addEventListener('open', () => {
    input.recordEvent(
      'rallar.direct.raw_ws.open.completed',
      {
        connection: input.connection,
        url: input.url,
        readyState: input.socket.readyState,
      },
      'Open WebSocket',
    );
    input.setWaitStatus('raw ws open');
    input.setActionFeedback(
      completedActionFeedback({
        label: input.label,
        startedAtEpochMs: input.startedAtEpochMs,
        target: input.url,
        ok: true,
        status: 'open',
        message: 'Raw WebSocket is open.',
      }),
    );
  });
  input.socket.addEventListener('message', (event) => {
    input.recordEvent(
      'rallar.direct.raw_ws.message',
      {
        connection: input.connection,
        data: parseRawWebSocketMessage(event.data),
      },
      'Raw WebSocket message received',
      'info',
      'message',
    );
  });
  input.socket.addEventListener('error', () => {
    input.recordEvent(
      'rallar.direct.raw_ws.error',
      {
        connection: input.connection,
        url: input.url,
        readyState: input.socket.readyState,
      },
      'Raw WebSocket error',
      'error',
    );
    input.setWaitStatus('raw ws error');
    input.setActionFeedback(
      completedActionFeedback({
        label: input.label,
        startedAtEpochMs: input.startedAtEpochMs,
        target: input.url,
        ok: false,
        statusText: 'error',
        message: 'Raw WebSocket emitted an error.',
      }),
    );
  });
  input.socket.addEventListener('close', (event) => {
    input.recordEvent(
      'rallar.direct.raw_ws.close',
      {
        connection: input.connection,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      },
      'Raw WebSocket closed',
      event.wasClean ? 'info' : 'warning',
    );
    input.setWaitStatus('raw ws closed');
  });
}

type RawWebSocketMessage = null | boolean | number | string | object;

function parseRawWebSocketMessage(data: string | object): RawWebSocketMessage {
  if (typeof data !== 'string') {
    return data;
  }

  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}
