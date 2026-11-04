import { readRallarGameParticipants } from '@shared/rallar-game/read-rallar-game-participants.ts';
import { evaluateRallarGameRematchStart, type RallarGameParticipant } from '@shared/rallar-game/rematch.ts';

import type { ArenaMatchState } from '@ar-eye-hunter/arena-contracts.ts';
import { createArenaRematch, type ArenaRematch } from '@ar-eye-hunter/arena-rematch.ts';
import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';
import type { ArenaRematchDraft } from '../game/arena-runtime/game-actions/use-arena-world-actions.ts';
import { useArenaRematchConfirmation } from './use-arena-rematch-confirmation.ts';

interface ArenaRematchControlsProps {
    readonly match: ArenaMatchState;
    readonly arena: ArenaConnection;
}

export function ArenaRematchControls({ match, arena }: ArenaRematchControlsProps) {
    const rematch = match.rematch ?? createArenaRematch(match).right;
    const participants = readRallarGameParticipants(
        arena.rooms.find((room) => room.roomId === arena.roomId)?.snapshot,
        Date.now()
    );
    const sessionId = arena.session?.sessionId;
    const member = participants.find((participant) => participant.sessionId === sessionId);
    const { pending, error, send } = useArenaRematchConfirmation({ arena, match, rematch, member });
    if (!rematch || !arena.session || arena.tournament.mode !== 'casual') {
        return null;
    }
    const confirmation = rematch.preparation.players.find((player) => player.sessionId === sessionId);
    const ready = confirmation?.ready && confirmation.participationKey === member?.participationKey;
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
                        onClick={() => send({ kind: 'ready', ready: !ready })}
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
            {pending && <p role="status">Waiting for the director to confirm…</p>}
            {error && <p role="alert">{error}</p>}
        </section>
    );
}

interface ArenaRematchRosterProps extends ArenaRematchControlsProps {
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
    readonly send: (draft: ArenaRematchDraft) => void;
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
                            send({ kind: 'settings', durationMs: duration });
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
                onClick={() => send({ kind: 'start' })}
            >
                Start next match
            </button>
            {start.left && <p role="status">{start.left.message}</p>}
        </>
    );
}
