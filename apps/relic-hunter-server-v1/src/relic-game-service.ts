import type { Hono } from 'jsr:@hono/hono';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import {
  applyRelicCommand,
  createRelicGame,
  isRelicCommand,
  RELIC_TOPICS,
  RELIC_TYPES,
  type RelicCommand,
  type RelicGameState,
  type RelicPublicSnapshot,
  type RelicServerEvent,
  toPublicRelicSnapshot,
} from '@relic-hunters/mod.ts';
import type { RallarServerApplication } from '@shared-server/rallar-facade/RallarServerApplication.ts';
import type { Middleware } from '../../api-v1/src/middleware.ts';

type RelicRallarServer = RallarServerApplication<Middleware, Hono>;

export type RelicHunterGameService = Readonly<{
  readSnapshot(gameId: string): Promise<RelicPublicSnapshot | undefined>;
  ensureSnapshot(gameId: string): Promise<RelicPublicSnapshot>;
  applyCommand(command: RelicCommand, senderId: string): Promise<RelicPublicSnapshot>;
  reset(gameId: string): Promise<RelicPublicSnapshot>;
}>;

export async function installRelicHunterGame(
  rallar: RelicRallarServer,
): Promise<RelicHunterGameService> {
  const games = await rallar.data.open<RelicGameState>(
    'relic-hunter-games',
    {
      namespace: 'relic-hunter-v1',
      schemaVersion: 1,
    },
  );

  // Serialize writes per game to prevent read-modify-write races when two
  // players submit actions simultaneously.
  const gameQueues = new Map<string, Promise<unknown>>();
  function enqueueForGame<T>(gameId: string, work: () => Promise<T>): Promise<T> {
    const prev = (gameQueues.get(gameId) ?? Promise.resolve()).catch(() => {});
    const next: Promise<T> = prev.then(work);
    gameQueues.set(gameId, next.catch(() => {}));
    return next;
  }

  async function publishSnapshot(state: RelicGameState): Promise<void> {
    const snapshot = toPublicRelicSnapshot(state);
    const event: RelicServerEvent = {
      protocolVersion: snapshot.protocolVersion,
      gameId: snapshot.gameId,
      snapshot,
    };

    await rallar.ws.publish(
      newALBroadcastMessage(
        'relic-hunter-server',
        newALRoute(
          RELIC_TOPICS.snapshot,
          state.roomId,
          `${state.gameId}:${state.round}`,
        ),
        'room',
        RELIC_TYPES.snapshot,
        event,
        {
          reliability: 'at-least-once',
          ttlMs: 15_000,
        },
      ),
      'live-only',
    );
  }

  async function applyCommand(
    command: RelicCommand,
    senderId: string,
  ): Promise<RelicPublicSnapshot> {
    return enqueueForGame(command.gameId, async () => {
      const previous = await games.get(command.gameId);
      const result = applyRelicCommand(previous, command, { senderId });
      await games.set(command.gameId, result.state);
      await publishSnapshot(result.state);
      return toPublicRelicSnapshot(result.state);
    });
  }

  rallar.ws.defineTopic<RelicCommand>({
    topicId: RELIC_TOPICS.command,
    typeId: RELIC_TYPES.command,
    scope: 'room',
    fanout: 'none',
    maxPayloadBytes: 16 * 1024,
    validate: (value, context) =>
      isRelicCommand(value) &&
      context.roomId !== undefined &&
      value.gameId === context.roomId,
  });

  rallar.ws.on<RelicCommand>(
    {
      topicId: RELIC_TOPICS.command,
      typeId: RELIC_TYPES.command,
    },
    async (message, context) => {
      await applyCommand(message.payload, context.senderId);
    },
  );

  return {
    readSnapshot: async (gameId) => {
      const game = await games.get(gameId);
      return game ? toPublicRelicSnapshot(game) : undefined;
    },
    ensureSnapshot: async (gameId) => {
      const game = await games.setIfAbsent(
        gameId,
        () => createRelicGame(gameId, gameId),
      );
      return toPublicRelicSnapshot(game);
    },
    applyCommand,
    reset: async (gameId) => {
      const state = createRelicGame(gameId, gameId);
      await games.set(gameId, state);
      await publishSnapshot(state);
      return toPublicRelicSnapshot(state);
    },
  };
}
