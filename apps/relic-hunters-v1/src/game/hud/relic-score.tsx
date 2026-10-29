import type {
    RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import { findRelicCharacter } from '@relic-hunters/mod.ts';
import { useMemo, type ReactNode } from 'react';
import { plural } from '../lang.ts';

interface EscapeDecisionPanelProps {
    readonly snapshot: RelicPublicSnapshot;
    readonly localPlayerId?: string;
}

export function EscapeDecisionPanel({
    snapshot,
    localPlayerId
}: EscapeDecisionPanelProps) {
    const sortedPlayers = [...snapshot.players].sort((a, b) => b.score - a.score);
    const localPlayer = snapshot.players.find((p) => p.playerId === localPlayerId);
    const localRank = sortedPlayers.findIndex((p) => p.playerId === localPlayerId) + 1;
    const carriedRelics = snapshot.relics.filter((r) => r.carriedBy === localPlayerId);
    const escapeScore = localPlayer && !localPlayer.escaped && !localPlayer.defeated
        ? localPlayer.score + carriedRelics.reduce((sum, r) => sum + r.value, 0)
        : undefined;
    const roundsLeft = snapshot.maxRounds - snapshot.round + 1;
    const hiddenRelicTotal = snapshot.relics
        .filter((r) => !r.foundBy && !r.carriedBy && !r.escapedBy)
        .reduce((sum, r) => sum + r.value, 0);

    return (
        <div className="panel stack escape-decision">
            <div>
                <span className="panel-label">Score Tracker</span>
                <strong>
                    {localPlayer?.escaped
                        ? 'You escaped safe'
                        : localPlayer?.defeated
                        ? 'You are down'
                        : `Rank ${localRank} of ${snapshot.players.length}`}
                </strong>
                {carriedRelics.length > 0 && (
                    <small>Carrying {carriedRelics.length} {plural('relic', carriedRelics.length)}</small>
                )}
            </div>
            {carriedRelics.length > 0 && <RelicInventory relics={carriedRelics} />}
            <RelicScoreBoard snapshot={snapshot} localPlayerId={localPlayerId} />
            {escapeScore !== undefined && snapshot.phase === 'planning' && (
                <div className="escape-projection">
                    <div className="escape-proj-row">
                        <span>Safe now</span>
                        <strong className="proj-safe">{escapeScore} pts</strong>
                    </div>
                    <div className="escape-proj-row">
                        <span>Still in ruin</span>
                        <strong>~{hiddenRelicTotal} pts</strong>
                    </div>
                    <div className={`escape-proj-row${roundsLeft <= 2 ? ' proj-urgent' : ''}`}>
                        <span>Rounds left</span>
                        <strong>{roundsLeft}</strong>
                    </div>
                </div>
            )}
        </div>
    );
}

interface VictoryPanelProps {
    readonly snapshot: RelicPublicSnapshot;
    readonly children?: ReactNode;
}

export function VictoryPanel({ snapshot, children }: VictoryPanelProps) {
    const winners = snapshot.players.filter((player) => snapshot.winnerIds.includes(player.playerId));
    const sortedPlayers = [...snapshot.players].sort((left, right) => right.score - left.score);
    return (
        <section className="victory-panel">
            <VictoryConfetti />
            <div>
                <span>The Heart Relic has chosen</span>
                <h2>{winners.map((winner) => winner.username).join(', ') || 'No hunter'}</h2>
                <p>Final score: {winners[0]?.score ?? 0}</p>
            </div>
            <div className="scoreboard">
                {sortedPlayers.map((player) => {
                    const char = findRelicCharacter(player.characterId);
                    const escapedRelics = snapshot.relics.filter((r) => r.escapedBy === player.playerId);
                    return (
                        <div key={player.playerId} className="final-score-row">
                            <span
                                className="final-score-swatch"
                                style={{ background: char.colors.accent }}
                            />
                            <span className="final-score-name">{player.username}</span>
                            <div className="final-score-details">
                                {escapedRelics.length > 0 && (
                                    <span className="final-score-relics">
                                        {escapedRelics.map((r) => `◆ ${r.name} (+${r.value})`).join('  ')}
                                    </span>
                                )}
                                {player.defeated && <span className="final-score-tag danger">fallen</span>}
                                {player.escaped && <span className="final-score-tag success">escaped</span>}
                                {!player.defeated && !player.escaped && (
                                    <span className="final-score-tag">still inside</span>
                                )}
                            </div>
                            <strong className="final-score-value">{player.score}</strong>
                        </div>
                    );
                })}
            </div>
            {children}
        </section>
    );
}
function RelicScoreBoard({ snapshot, localPlayerId }: EscapeDecisionPanelProps) {
    const sortedPlayers = [...snapshot.players].sort((left, right) => right.score - left.score);
    return (
        <div className="score-board">
            {sortedPlayers.map((player, rank) => {
                const character = findRelicCharacter(player.characterId);
                const isLocal = player.playerId === localPlayerId;
                const maxHealth = 3 + (character.healthBonus ?? 0);
                return (
                    <div
                        key={player.playerId}
                        className={`score-row${isLocal ? ' local' : ''}`}
                    >
                        <span className="score-rank" style={{ color: character.colors.accent }}>
                            {rank + 1}
                        </span>
                        <span className="score-name">{player.username}</span>
                        <span className="score-health" aria-label={`${player.health} health`}>
                            {Array.from({ length: maxHealth }, (_, i) => (
                                <span
                                    key={i}
                                    className={`health-pip ${i < player.health ? 'pip-full' : 'pip-empty'} ${
                                        player.health === 1 && i === 0 ? 'pip-critical' : ''
                                    }`}
                                />
                            ))}
                        </span>
                        <strong className="score-value">{player.score}</strong>
                        {player.relicIds.length > 0 && <span className="score-relics">◆{player.relicIds.length}</span>}
                        {player.escaped && <em className="score-status">out</em>}
                        {player.defeated && <em className="score-status score-status-down">down</em>}
                    </div>
                );
            })}
        </div>
    );
}
function VictoryConfetti() {
    const confettiPieces = useMemo(() =>
        Array.from({ length: 20 }, (_, i) => ({
            key: i,
            color: ['#facc5b', '#4ade80', '#7dd3fc', '#c4b5fd', '#fb7185'][i % 5],
            left: `${5 + ((i * 73 + 17) % 90)}%`,
            delay: `${(i * 137) % 2200}ms`,
            duration: `${1800 + (i * 79) % 1400}ms`,
            size: `${6 + (i * 31) % 9}px`
        })), []);
    return (
        <div className="victory-confetti" aria-hidden="true">
            {confettiPieces.map((p) => (
                <div
                    key={p.key}
                    className="confetti-piece"
                    style={{
                        left: p.left,
                        background: p.color,
                        animationDelay: p.delay,
                        animationDuration: p.duration,
                        width: p.size,
                        height: p.size
                    }}
                />
            ))}
        </div>
    );
}
interface RelicInventoryProps {
    readonly relics: RelicPublicSnapshot['relics'];
}
function RelicInventory({ relics }: RelicInventoryProps) {
    return (
        <div className="relic-inventory">
            {relics.map((r) => (
                <div key={r.id} className="relic-item">
                    <span className="relic-item-name">◆ {r.name}</span>
                    <span className="relic-item-value">+{r.value}</span>
                </div>
            ))}
        </div>
    );
}
