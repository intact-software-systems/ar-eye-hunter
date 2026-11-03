import type { ArenaMatchState } from '../game/arena-contracts.ts';
import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';
import { ArenaRematchControls } from './arena-rematch-controls.tsx';

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
                <ArenaRematchControls
                    key={`${arena.session?.sessionId}:${match.matchId}`}
                    match={match}
                    arena={arena}
                />
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
