import {
  createRallarMediaFacade,
  type RallarMediaFacade,
} from '@shared-web/browser/rallar-media-facade.ts';
import {
  createRallarMessagesFacade,
  type RallarMessagesFacade,
} from '@shared-web/browser/rallar-messages-facade.ts';
import {
  createRallarRealtimeFacade,
  type RallarRealtimeFacade,
} from '@shared-web/browser/rallar-realtime-facade.ts';
import {
  createRallarRtcFacade,
  type RallarRtcFacade,
} from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarBrowserFacadeRuntimeContext } from '../../rallar-runtime-context.ts';
import type { RallarMediaPort } from '@shared-web/browser/rallar-runtime/contracts.ts';
import { createRallarMediaController } from '@shared-web/browser/rallar-runtime/media.ts';
import {
  createRallarMessagesController,
  type RallarMessagesController,
} from '@shared-web/browser/rallar-runtime/messages.ts';
import {
  createRallarRealtimeController,
  type RallarRealtimeController,
} from '@shared-web/browser/rallar-runtime/realtime.ts';
import {
  createRallarRtcController,
  type RallarRtcController,
} from '@shared-web/browser/rallar-runtime/rtc.ts';
import type { RallarSessionController } from '@shared-web/browser/rallar-runtime/session.ts';
import {
  createRallarWsController,
  type RallarWsController,
} from '@shared-web/browser/rallar-runtime/ws.ts';
import type { RallarWsInbox } from '@shared-web/browser/rallar-runtime/ws-inbox.ts';
import { readSession } from '@shared/api/auth.ts';
import { RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES } from '@shared/api/rallar-validation.ts';

import type { BrowserStateComposition } from './browser-runtime-composition.ts';

const DEFAULT_RALLAR_REALTIME_LANE_ID = 'realtime';
const DEFAULT_RALLAR_REALTIME_OPEN_TIMEOUT_MS = 5_000;

export interface BrowserMessagingComposition {
  readonly messagesController: RallarMessagesController;
  readonly messages: RallarMessagesFacade;
}

export interface BrowserRealtimeComposition {
  readonly wsController: RallarWsController;
  readonly rtcController: RallarRtcController;
  readonly rtc: RallarRtcFacade;
  readonly realtimeController: RallarRealtimeController;
  readonly realtime: RallarRealtimeFacade;
  readonly mediaController: RallarMediaPort;
  readonly media: RallarMediaFacade;
}

export interface CreateBrowserMessagingCompositionInput {
  readonly wsInbox: RallarWsInbox;
  readonly state: BrowserStateComposition;
  readonly readSessionController: () => RallarSessionController;
}

export interface CreateBrowserRealtimeCompositionInput {
  readonly runtime: RallarBrowserFacadeRuntimeContext;
  readonly state: BrowserStateComposition;
  readonly readSessionController: () => RallarSessionController;
}

export function createBrowserMessagingComposition(
  input: CreateBrowserMessagingCompositionInput,
): BrowserMessagingComposition {
  const messagesController = createRallarMessagesController({
    wsInbox: input.wsInbox,
    connect: async () => await input.readSessionController().connect(),
    readMiddleware: () => input.readSessionController().readMiddleware(),
    requireSession: () => input.readSessionController().requireSession(),
    resolveDefaultRoom: input.state.resolveDefaultRoom,
    resolveCurrentRoomRef: () => input.state.roomStateStore.resolveCurrentRoomRef(),
    toRoomId: (room) => input.state.roomStateStore.toRoomId(room),
    resolveRoomRef: (room) => input.state.roomStateStore.resolveRoomRef(room),
    resolveRoomMinSnapshotVersion: (room, explicit) =>
      input.state.roomStateStore.resolveRoomMinSnapshotVersion(room, explicit),
    resolveRoomPeerIds: input.state.resolveRoomPeerIds,
    readMessageMaxPayloadBytes: () =>
      input.state.readDefaults()?.messages?.maxPayloadBytes ??
      RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES,
  });
  return {
    messagesController,
    messages: createRallarMessagesFacade(messagesController.operations),
  };
}

export function createBrowserRealtimeComposition(
  input: CreateBrowserRealtimeCompositionInput,
): BrowserRealtimeComposition {
  const wsController = createRallarWsController({
    readMiddleware: () => input.readSessionController().readMiddleware(),
    readSession,
    readConnectState: () => input.runtime.readConnectState(),
  });
  const rtcController = createRallarRtcController({
    readMiddleware: () => input.readSessionController().readMiddleware(),
    readSession,
    readWsStatus: () => wsController.facade.status(),
    resolveRoomPeerIds: input.state.resolveRoomPeerIds,
    resolveRoomRef: (room) => input.state.roomStateStore.resolveRoomRef(room),
    toRoomId: (room) => input.state.roomStateStore.toRoomId(room),
    resolveRtcWaitTimeoutMs: (timeoutMs) =>
      timeoutMs ?? input.state.readDefaults()?.rtc?.waitTimeoutMs,
    resolveRtcConnectOnWait: (connect) =>
      connect ?? input.state.readDefaults()?.rtc?.connectOnWait ?? false,
  });
  const rtc = createRallarRtcFacade(rtcController.operations);
  const realtimeController = createRallarRealtimeController({
    connect: async () => await input.readSessionController().connect(),
    readMiddleware: () => input.readSessionController().readMiddleware(),
    readSession,
    readDefaultRoom: input.state.resolveDefaultRoom,
    readCurrentRoomRef: () => input.state.roomStateStore.resolveCurrentRoomRef(),
    readCurrentRoomSnapshot: () => input.state.roomStateStore.state().currentRoom,
    findGroupSnapshot: (room) => input.state.roomStateStore.findGroupSnapshot(room),
    resolveRoomPeerIds: input.state.resolveRoomPeerIds,
    resolveLaneId: (laneId) =>
      laneId ?? input.state.readDefaults()?.realtime?.laneId ?? DEFAULT_RALLAR_REALTIME_LANE_ID,
    resolveOpenTimeoutMs: (openTimeoutMs) =>
      openTimeoutMs ??
      input.state.readDefaults()?.realtime?.openTimeoutMs ??
      DEFAULT_RALLAR_REALTIME_OPEN_TIMEOUT_MS,
    rtc,
  });
  const realtime = createRallarRealtimeFacade(realtimeController.operations);
  const mediaController = createRallarMediaController({
    connect: async () => await input.readSessionController().connect(),
    readMiddleware: () => input.readSessionController().readMiddleware(),
  });
  return {
    wsController,
    rtcController,
    rtc,
    realtimeController,
    realtime,
    mediaController,
    media: createRallarMediaFacade(mediaController.operations),
  };
}
