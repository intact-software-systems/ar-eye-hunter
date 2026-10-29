import { RELIC_CHARACTERS, type RelicCharacterId } from '@relic-hunters/mod.ts';
import type { RelicRematch } from '@relic-hunters/src/model.ts';
import { createRelicRematch } from '@relic-hunters/src/relic-rematch.ts';
import { readRallarGameParticipants } from '@shared/rallar-game/read-rallar-game-participants.ts';
import type { RallarGameParticipant } from '@shared/rallar-game/rematch.ts';
import { evaluateRallarGameRematchStart } from '@shared/rallar-game/rematch.ts';
import { useEffect, useState } from 'react';
import type { RelicHuntersRuntime } from '../relic-hunters-runtime.ts';

interface RelicRematchControlsProps {
    readonly game: RelicHuntersRuntime.Connection;
}

/** Results stay visible while the server collects consent for the next expedition. */
export function RelicRematchControls({ game }: RelicRematchControlsProps) {
    const [characterId, setCharacterId] = useState<RelicCharacterId>(RELIC_CHARACTERS[0].id);
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, []);
    const snapshot = game.snapshot;
    if (!snapshot || snapshot.phase !== 'finished' || !game.session) {
        return null;
    }
    const rematch = snapshot.rematch ?? createRelicRematch(snapshot).right;
    if (!rematch) {
        return null;
    }
    const participants = readRallarGameParticipants(
        game.rooms.find((room) => room.roomId === game.roomId)?.snapshot,
        now
    );
    return (
        <RelicRematchPanel
            game={game}
            rematch={rematch}
            participants={participants}
            characterId={characterId}
            onCharacterChange={setCharacterId}
        />
    );
}
interface RelicRematchPanelProps {
    readonly game: RelicHuntersRuntime.Connection;
    readonly rematch: RelicRematch;
    readonly participants: readonly RallarGameParticipant[];
    readonly characterId: RelicCharacterId;
    readonly onCharacterChange: (characterId: RelicCharacterId) => void;
}

function RelicRematchPanel({ game, rematch, participants, characterId, onCharacterChange }: RelicRematchPanelProps) {
    const sessionId = game.session!.sessionId;
    const membership = participants.find((participant) => participant.sessionId === sessionId);
    const consent = rematch.preparation.players.find((player) => player.sessionId === sessionId);
    const ready = consent?.ready && consent.participationKey === membership?.participationKey;
    const hunter = rematch.hunters.find((candidate) => candidate.playerId === sessionId);
    const pending = game.diagnostics.commandInFlight !== undefined;
    return (
        <section className="panel stack" aria-label="Play again together">
            <h3>Play again together</h3>
            <p>Stay in this room. Each present hunter confirms; the Keeper starts when everyone is ready.</p>
            <RelicRematchRoster rematch={rematch} participants={participants} />
            {game.participation === 'spectator' ? <p>Watching — join as player to opt in.</p> : (
                <>
                    {!hunter && (
                        <label>
                            Next hunter<select
                                value={characterId}
                                onChange={(event) => onCharacterChange(event.target.value as RelicCharacterId)}
                            >
                                {RELIC_CHARACTERS.map((character) => (
                                    <option key={character.id} value={character.id}>{character.name}</option>
                                ))}
                            </select>
                        </label>
                    )}
                    <button
                        type="button"
                        disabled={pending || !membership}
                        onClick={() => void game.setRematchReady(!ready, hunter?.characterId ?? characterId)}
                    >
                        {ready ? 'Cancel ready' : 'Play again'}
                    </button>
                    {game.snapshot?.adminPlayerId === sessionId && (
                        <RelicRematchLeader game={game} rematch={rematch} participants={participants} />
                    )}
                </>
            )}
        </section>
    );
}

interface RelicRematchRosterProps {
    readonly rematch: RelicRematch;
    readonly participants: readonly RallarGameParticipant[];
}

function RelicRematchRoster({ rematch, participants }: RelicRematchRosterProps) {
    return (
        <ul aria-label="Next expedition players">
            {rematch.hunters.map((candidate) => {
                const participant = participants.find((entry) => entry.sessionId === candidate.playerId);
                const confirmation = rematch.preparation.players.find((entry) =>
                    entry.sessionId === candidate.playerId
                );
                return (
                    <li key={candidate.playerId}>
                        {candidate.username}: {!participant
                            ? 'away'
                            : confirmation?.ready && confirmation.participationKey === participant.participationKey
                            ? 'ready'
                            : 'waiting'}
                    </li>
                );
            })}
        </ul>
    );
}

interface RelicRematchLeaderProps extends RelicRematchRosterProps {
    readonly game: RelicHuntersRuntime.Connection;
}

function RelicRematchLeader({ game, rematch, participants }: RelicRematchLeaderProps) {
    const pending = game.diagnostics.commandInFlight !== undefined;
    const start = evaluateRallarGameRematchStart(rematch.preparation, {
        ...rematch.preparation,
        participants,
        actorSessionId: game.session!.sessionId,
        leaderSessionId: game.snapshot?.adminPlayerId
    });
    return (
        <>
            <label>
                Next round time<select
                    value={rematch.roundTimeLimitMs}
                    disabled={pending}
                    onChange={(event) => void game.setRematchRoundLimit(Number(event.target.value))}
                >
                    <option value={60_000}>1 minute</option>
                    <option value={180_000}>3 minutes</option>
                    <option value={300_000}>5 minutes</option>
                </select>
            </label>
            <button
                type="button"
                className="primary"
                disabled={pending || start.right === undefined}
                onClick={() => void game.startRematch()}
            >
                Start next expedition
            </button>
            {start.left && <p role="status">{start.left.message}</p>}
        </>
    );
}
