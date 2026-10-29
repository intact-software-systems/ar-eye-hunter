import { readRallarGameParticipants } from '@shared/rallar-game/read-rallar-game-participants.ts';
import type { RallarGameParticipant } from '@shared/rallar-game/rematch.ts';
import { evaluateRallarGameRematchStart } from '@shared/rallar-game/rematch.ts';
import { useState } from 'react';
import type { ArenaMatchState } from '../game/arena-contracts.ts';
import type { ArenaRematch } from '../game/arena-rematch.ts';
import { createArenaRematch } from '../game/arena-rematch.ts';
import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';
interface MatchWinnerOverlayProps {
    readonly match: ArenaMatchState;
    readonly arena: ArenaConnection;
}
export function MatchWinnerOverlay({
    match,
    arena
}: MatchWinnerOverlayProps) {
    const winner = match.results?.[0];
    return (
        <section className="match-winner" role="dialog" aria-modal="false" aria-label="Match results">
            <div className="match-winner__panel">
                <span className="match-winner__eyebrow">Arena Match Complete</span>
                <h2>{winner ? `${winner.username} survives the metrics` : 'The metrics are inconclusive'}</h2>
                <p>
                    {winner
                        ? `${winner.scoreDelta} score, ${winner.killsDelta} eliminations, ${winner.deathsDelta} deaths. HR calls this character building.`
                        : 'Nobody won, which is legally cheaper.'}
                </p>
                <div className="match-results">
                    {(match.results ?? []).slice(0, 5).map((standing) => (
                        <div className="match-result-row" key={standing.sessionId}>
                            <strong>#{standing.rank} {standing.username}</strong>
                            <span>{standing.scoreDelta} pts</span>
                            <span>{standing.killsDelta} K</span>
                            <span>{standing.deathsDelta} D</span>
                        </div>
                    ))}
                </div>
                <ArenaRematchControls match={match} arena={arena} />
                <div className="button-grid" aria-label="Arena actions">
                    <button type="button" onClick={() => void arena.leaveRoom()}>Leave arena</button>
                    {arena.spectating
                        ? <button type="button" onClick={() => void arena.joinAsPlayer()}>Join as player</button>
                        : (
                            <button type="button" onClick={() => arena.roomId && void arena.watchRoom(arena.roomId)}>
                                Watch next match
                            </button>
                        )}
                    {!arena.spectating && !arena.directorStatus.isDirector && (
                        <button
                            type="button"
                            onClick={() => void arena.appointSelfAsDirector()}
                        >
                            Appoint this SPA
                        </button>
                    )}
                </div>
            </div>
        </section>
    );
}

function ArenaRematchControls({ match, arena }: MatchWinnerOverlayProps) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string>();
    const rematch = match.rematch ?? createArenaRematch(match).right;
    if (!rematch || !arena.session) {
        return null;
    }
    const participants = readRallarGameParticipants(
        arena.rooms.find((room) => room.roomId === arena.roomId)?.snapshot,
        Date.now()
    );
    const sessionId = arena.session.sessionId;
    const member = participants.find((participant) => participant.sessionId === sessionId);
    const confirmation = rematch.preparation.players.find((player) => player.sessionId === sessionId);
    const ready = confirmation?.ready && confirmation.participationKey === member?.participationKey;
    const send = async (action: () => Promise<void>) => {
        setPending(true);
        setError(undefined);
        try {
            await action();
        }
        catch (failure) {
            setError(failure instanceof Error ? failure.message : 'The rematch command could not be delivered.');
        }
        finally {
            setPending(false);
        }
    };
    return (
        <section aria-label="Play again together">
            <h3>Play again together</h3>
            <p>Everyone confirms. The director starts the next match in this arena.</p>
            <ArenaRematchRoster match={match} arena={arena} rematch={rematch} participants={participants} />
            {arena.spectating ? <p>Watching — join as player to opt in.</p> : (
                <>
                    <button
                        type="button"
                        disabled={pending || !member || !arena.directorStatus.isFresh}
                        onClick={() => void send(() => arena.setRematchReady(!ready))}
                    >
                        {ready ? 'Cancel ready' : 'Play again'}
                    </button>
                    {arena.directorStatus.isDirector && (
                        <ArenaRematchLeader
                            arena={arena}
                            rematch={rematch}
                            participants={participants}
                            pending={pending}
                            send={send}
                        />
                    )}
                </>
            )}
            {error && <p role="alert">{error}</p>}
        </section>
    );
}

interface ArenaRematchRosterProps extends MatchWinnerOverlayProps {
    readonly rematch: ArenaRematch;
    readonly participants: readonly RallarGameParticipant[];
}
function ArenaRematchRoster({ match, arena, rematch, participants }: ArenaRematchRosterProps) {
    return (
        <ul aria-label="Next match players">
            {rematch.preparation.players.map((player) => {
                const participant = participants.find((entry) => entry.sessionId === player.sessionId);
                const name = arena.arenaSnapshot?.players.find((entry) =>
                    entry.sessionId === player.sessionId
                )?.username ?? match.results?.find((result) => result.sessionId === player.sessionId)?.username ??
                    match.baseline[player.sessionId]?.username ?? player.sessionId;
                return (
                    <li key={player.sessionId}>
                        {name}: {!participant
                            ? 'away'
                            : player.ready && player.participationKey === participant.participationKey
                            ? 'ready'
                            : 'waiting'}
                    </li>
                );
            })}
        </ul>
    );
}
interface ArenaRematchLeaderProps {
    readonly arena: ArenaConnection;
    readonly rematch: ArenaRematch;
    readonly participants: readonly RallarGameParticipant[];
    readonly pending: boolean;
    readonly send: (action: () => Promise<void>) => Promise<void>;
}
function ArenaRematchLeader({ arena, rematch, participants, pending, send }: ArenaRematchLeaderProps) {
    const start = evaluateRallarGameRematchStart(rematch.preparation, {
        ...rematch.preparation,
        participants,
        actorSessionId: arena.session!.sessionId,
        leaderSessionId: arena.directorStatus.appointment?.sessionId
    });
    return (
        <>
            <label>
                Next match duration<select
                    value={rematch.durationMs}
                    disabled={pending}
                    onChange={(event) => {
                        const duration = Number(event.target.value);
                        if (duration === 60_000 || duration === 180_000 || duration === 300_000) {
                            void send(() => arena.setRematchDuration(duration));
                        }
                    }}
                >
                    <option value={60_000}>1 minute</option>
                    <option value={180_000}>3 minutes</option>
                    <option value={300_000}>5 minutes</option>
                </select>
            </label>
            <button
                type="button"
                className="primary"
                disabled={pending || !arena.directorStatus.isFresh || start.right === undefined}
                onClick={() => void send(arena.startRematch)}
            >
                Start next match
            </button>
            {start.left && <p role="status">{start.left.message}</p>}
        </>
    );
}
