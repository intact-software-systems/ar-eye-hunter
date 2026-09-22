import type { ArenaMatchState } from '../game/types.ts';
interface MatchWinnerOverlayProps {
    readonly match: ArenaMatchState;
    readonly onClose: () => void;
}
export function MatchWinnerOverlay({
    match,
    onClose
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
                <button type="button" className="primary" onClick={onClose}>
                    Continue infinite chaos
                </button>
            </div>
        </section>
    );
}
