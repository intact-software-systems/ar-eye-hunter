import type {
    RallarMatchStandingComparator,
    RallarMatchStandingRow,
    RallarRoomTrustedMatchResult
} from '@shared/rallar-match/mod.ts';
import {
    createRallarMatchResult,
    deriveRallarMatchParticipants,
    deriveRallarMatchStandings
} from '@shared/rallar-match/mod.ts';
import { createRallarGameMatch } from '../match.ts';
import type { RallarGameSendResult } from '../transport/rallar-game-send-result.ts';
import type { RallarGameMatchConfig, RallarGameMatchHandle } from './rallar-game-match-contracts.ts';

export type RallarBrowserMatchConfig<TCommand, TSnapshot, TEvent, TPresence = TCommand> =
    & Omit<RallarGameMatchConfig<TCommand, TCommand, TSnapshot, TEvent, TPresence>, 'onInput' | 'onIntent'>
    & Readonly<{
        matchId: string;
        startedAtEpochMs?: number;
        onCommand?: RallarGameMatchConfig<TCommand, TCommand, TSnapshot, TEvent, TPresence>['onIntent'];
        readStandingRows?: () => readonly RallarMatchStandingRow[];
        compareStandings?: RallarMatchStandingComparator;
    }>;

export type RallarBrowserMatchDependencies<TCommand, TSnapshot, TEvent, TPresence = TCommand> = Readonly<{
    createGameMatch?: (
        config: RallarGameMatchConfig<TCommand, TCommand, TSnapshot, TEvent, TPresence>
    ) => RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>;
    nowEpochMs?: () => number;
    resultId?: () => string;
}>;

export type RallarBrowserMatchHandle<TCommand, TSnapshot, TEvent, TPresence = TCommand> = Readonly<{
    game: RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>;
    start: RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>['start'];
    stop: RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>['stop'];
    status: RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>['status'];
    diagnostics: RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>['diagnostics'];
    submitCommand(command: TCommand): Promise<RallarGameSendResult>;
    participants: typeof deriveRallarMatchParticipants;
    standings(): ReturnType<typeof deriveRallarMatchStandings>;
    finalizeResult<TSummary>(
        summary: TSummary
    ): RallarRoomTrustedMatchResult<TSummary>;
}>;

interface FinalizeRallarBrowserMatchResultInput<TCommand, TSnapshot, TEvent, TPresence, TSummary> {
    readonly config: RallarBrowserMatchConfig<TCommand, TSnapshot, TEvent, TPresence>;
    readonly game: RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>;
    readonly summary: TSummary;
    readonly nowEpochMs: () => number;
    readonly resultId: () => string;
    readonly standings: ReturnType<typeof deriveRallarMatchStandings>;
}

export function createRallarBrowserMatch<TCommand, TSnapshot, TEvent, TPresence = TCommand>(
    config: RallarBrowserMatchConfig<TCommand, TSnapshot, TEvent, TPresence>,
    dependencies: RallarBrowserMatchDependencies<TCommand, TSnapshot, TEvent, TPresence> = {}
): RallarBrowserMatchHandle<TCommand, TSnapshot, TEvent, TPresence> {
    const createGameMatch = dependencies.createGameMatch ?? createRallarGameMatch;
    const game = createGameMatch(toRallarGameMatchConfig(config));
    const nowEpochMs = dependencies.nowEpochMs ?? Date.now;
    const resultId = dependencies.resultId ?? (() => `${config.matchId}:${nowEpochMs()}`);
    const deriveStandings = () =>
        deriveRallarMatchStandings({
            rows: config.readStandingRows?.() ?? [],
            compare: config.compareStandings
        });

    return {
        game,
        start: game.start,
        stop: game.stop,
        status: game.status,
        diagnostics: game.diagnostics,
        submitCommand: (command) => game.sendIntent(command),
        participants: deriveRallarMatchParticipants,
        standings: deriveStandings,
        finalizeResult: (summary) =>
            finalizeRallarBrowserMatchResult({
                config,
                game,
                summary,
                nowEpochMs,
                resultId,
                standings: deriveStandings()
            })
    };
}

function toRallarGameMatchConfig<TCommand, TSnapshot, TEvent, TPresence>(
    config: RallarBrowserMatchConfig<TCommand, TSnapshot, TEvent, TPresence>
): RallarGameMatchConfig<TCommand, TCommand, TSnapshot, TEvent, TPresence> {
    return {
        rallar: config.rallar,
        protocol: config.protocol,
        topicId: config.topicId,
        matchId: config.matchId,
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
        onSyncRequest: config.onSyncRequest
    };
}

function finalizeRallarBrowserMatchResult<TCommand, TSnapshot, TEvent, TPresence, TSummary>(
    input: FinalizeRallarBrowserMatchResultInput<TCommand, TSnapshot, TEvent, TPresence, TSummary>
): RallarRoomTrustedMatchResult<TSummary> {
    const { config, game } = input;
    const roomRef = game.status().roomRef ??
        config.roomRef ??
        config.rallar.rooms.state().currentRoomRef;
    if (!roomRef) {
        throw new Error('Cannot finalize a Rallar match result without a roomRef.');
    }
    const directorStatus = config.rallar.director.status(roomRef);
    const appointment = directorStatus.appointment;
    if (!appointment || !directorStatus.isFresh) {
        throw new Error(
            'Cannot finalize a room-trusted Rallar match result without a fresh director appointment.'
        );
    }
    const session = config.rallar.session();
    if (
        !session ||
        !directorStatus.isDirector ||
        appointment.sessionId !== session.sessionId ||
        appointment.principalId !== session.clientId
    ) {
        throw new Error(
            'Cannot finalize a room-trusted Rallar match result unless the local session holds the director appointment.'
        );
    }

    return createRallarMatchResult({
        resultId: input.resultId(),
        matchId: config.matchId,
        roomRef,
        protocol: config.protocol,
        authority: {
            kind: 'browser-director',
            id: appointment.sessionId,
            epoch: appointment.epoch,
            principalId: appointment.principalId,
            sessionId: appointment.sessionId
        },
        trust: 'room-trusted',
        startedAtEpochMs: config.startedAtEpochMs,
        finishedAtEpochMs: input.nowEpochMs(),
        standings: input.standings,
        summary: input.summary
    });
}
