import type {
    RallarMatchResult,
    RallarMatchStandingRow,
} from '@shared/rallar-match/mod.ts';
import {
    createRallarMatchResult,
    deriveRallarMatchParticipants,
    deriveRallarMatchStandings,
} from '@shared/rallar-match/mod.ts';
import { createRallarGameMatch } from './match.ts';
import type {
    RallarGameMatchConfig,
    RallarGameMatchHandle,
    RallarGameSendResult,
} from './types.ts';

export type RallarBrowserMatchConfig<
    TCommand,
    TSnapshot,
    TEvent,
    TPresence = TCommand,
> =
    Omit<
        RallarGameMatchConfig<TCommand, TCommand, TSnapshot, TEvent, TPresence>,
        'onInput' | 'onIntent'
    > &
    Readonly<{
        matchId: string;
        startedAtEpochMs?: number;
        onCommand?: RallarGameMatchConfig<
            TCommand,
            TCommand,
            TSnapshot,
            TEvent,
            TPresence
        >['onIntent'];
        readStandingRows?: () => readonly RallarMatchStandingRow[];
    }>;

export type RallarBrowserMatchDependencies<
    TCommand,
    TSnapshot,
    TEvent,
    TPresence = TCommand,
> = Readonly<{
    createGameMatch?: (
        config: RallarGameMatchConfig<
            TCommand,
            TCommand,
            TSnapshot,
            TEvent,
            TPresence
        >,
    ) => RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>;
    nowEpochMs?: () => number;
    resultId?: () => string;
}>;

export type RallarBrowserMatchHandle<
    TCommand,
    TSnapshot,
    TEvent,
    TPresence = TCommand,
> = Readonly<{
    game: RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>;
    start: RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>['start'];
    stop: RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>['stop'];
    status: RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>['status'];
    diagnostics: RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>['diagnostics'];
    submitCommand(command: TCommand): Promise<RallarGameSendResult>;
    participants: typeof deriveRallarMatchParticipants;
    standings(): ReturnType<typeof deriveRallarMatchStandings>;
    finalizeResult<TSummary>(summary: TSummary): RallarMatchResult<TSummary>;
}>;

export function createRallarBrowserMatch<
    TCommand,
    TSnapshot,
    TEvent,
    TPresence = TCommand,
>(
    config: RallarBrowserMatchConfig<TCommand, TSnapshot, TEvent, TPresence>,
    dependencies: RallarBrowserMatchDependencies<
        TCommand,
        TSnapshot,
        TEvent,
        TPresence
    > = {},
): RallarBrowserMatchHandle<TCommand, TSnapshot, TEvent, TPresence> {
    const createGameMatch = dependencies.createGameMatch ?? createRallarGameMatch;
    const gameConfig: RallarGameMatchConfig<
        TCommand,
        TCommand,
        TSnapshot,
        TEvent,
        TPresence
    > = {
        rallar: config.rallar,
        protocol: config.protocol,
        topicId: config.topicId,
        roomId: config.roomId,
        roomRef: config.roomRef,
        laneIds: config.laneIds,
        typeIds: config.typeIds,
        heartbeatTtlMs: config.heartbeatTtlMs,
        capabilityTtlMs: config.capabilityTtlMs,
        readCapability: config.readCapability,
        resolvePeerIds: config.resolvePeerIds,
        scoreHost: config.scoreHost,
        directorAppointmentPolicy: config.directorAppointmentPolicy,
        canAppointDirector: config.canAppointDirector,
        readSnapshot: config.readSnapshot,
        autoSnapshotIntervalMs: config.autoSnapshotIntervalMs,
        onPresence: config.onPresence,
        onInput: config.onCommand,
        onIntent: config.onCommand,
        onSnapshot: config.onSnapshot,
        onEvent: config.onEvent,
        onSyncRequest: config.onSyncRequest,
    };
    const game = createGameMatch(gameConfig);
    const nowEpochMs = dependencies.nowEpochMs ?? Date.now;
    const resultId = dependencies.resultId ??
        (() => `${config.matchId}:${nowEpochMs()}`);

    return {
        game,
        start: game.start,
        stop: game.stop,
        status: game.status,
        diagnostics: game.diagnostics,
        submitCommand: (command) => game.sendIntent(command),
        participants: deriveRallarMatchParticipants,
        standings: () =>
            deriveRallarMatchStandings({
                rows: config.readStandingRows?.() ?? [],
            }),
        finalizeResult: (summary) => {
            const status = game.status();
            const roomRef = status.roomRef ??
                config.roomRef ??
                config.rallar.rooms.state().currentRoomRef;
            if (!roomRef) {
                throw new Error('Cannot finalize a Rallar match result without a roomRef.');
            }

            return createRallarMatchResult({
                resultId: resultId(),
                matchId: config.matchId,
                roomRef,
                protocol: config.protocol,
                authority: {
                    kind: 'browser-director',
                    id: status.directorPeerId ?? status.localPeerId ?? 'unknown-director',
                    epoch: status.directorEpoch ?? 0,
                    sessionId: status.directorPeerId ?? status.localPeerId,
                },
                trust: 'room-trusted',
                startedAtEpochMs: config.startedAtEpochMs,
                finishedAtEpochMs: nowEpochMs(),
                standings: deriveRallarMatchStandings({
                    rows: config.readStandingRows?.() ?? [],
                }),
                summary,
            });
        },
    };
}
