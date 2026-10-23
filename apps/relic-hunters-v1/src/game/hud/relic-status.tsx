import type {
    RelicPublicSnapshot
} from '@relic-hunters/mod.ts';

interface RelicStatusProps {
    readonly phaseText: string;
    readonly snapshot?: RelicPublicSnapshot;
    onToggleHelp(): void;
}

export function RelicStatus({
    phaseText,
    snapshot,
    onToggleHelp
}: RelicStatusProps) {
    return (
        <section className="topbar">
            <div className="brand">
                <span className="brand-mark" />
                <div>
                    <h1>Relic Hunters</h1>
                    <p>{phaseText}</p>
                </div>
            </div>
            <div className="status-row">
                {snapshot
                    ? <RoundStatus round={snapshot.round} maxRounds={snapshot.maxRounds} />
                    : <Status label="Round" value="-" />}
                <Status label="Hunters" value={String(snapshot?.players.length ?? 0)} />
                <Status label="Submitted" value={String(snapshot?.submittedPlayerIds.length ?? 0)} />
                <RelicProgressPill relics={snapshot?.relics} />
                <WinLeader snapshot={snapshot} />
                <button
                    type="button"
                    className="help-toggle"
                    aria-label="Keyboard shortcuts"
                    onClick={onToggleHelp}
                >
                    ?
                </button>
            </div>
        </section>
    );
}

interface StatusProps {
    readonly label: string;
    readonly value: string;
}

function Status({ label, value }: StatusProps) {
    return (
        <div className="status-pill">
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}

interface WinLeaderProps {
    readonly snapshot?: RelicPublicSnapshot;
}

function WinLeader({ snapshot }: WinLeaderProps) {
    if (!snapshot || snapshot.phase === 'lobby') {
        return <Status label="Leader" value="-" />;
    }
    const leader = [...snapshot.players].sort((a, b) => {
        const aScore = a.score +
            snapshot.relics.filter((r) => r.carriedBy === a.playerId).reduce((s, r) => s + r.value, 0);
        const bScore = b.score +
            snapshot.relics.filter((r) => r.carriedBy === b.playerId).reduce((s, r) => s + r.value, 0);
        return bScore - aScore;
    })[0];
    if (!leader) {
        return <Status label="Leader" value="-" />;
    }
    const projectedScore = leader.score +
        snapshot.relics.filter((r) => r.carriedBy === leader.playerId).reduce((s, r) => s + r.value, 0);
    return (
        <div className="status-pill">
            <span>Leader</span>
            <strong>
                {leader.username.length > 8 ? leader.username.slice(0, 7) + '…' : leader.username} · {projectedScore}
            </strong>
        </div>
    );
}

interface RoundStatusProps {
    readonly round: number;
    readonly maxRounds: number;
}

function RoundStatus({ round, maxRounds }: RoundStatusProps) {
    const pct = Math.min(100, (round / maxRounds) * 100);
    const urgentClass = pct >= 70 ? 'round-urgent' : pct >= 45 ? 'round-near' : '';
    return (
        <div className={`status-pill round-status ${urgentClass}`}>
            <span>Round</span>
            <strong>{round} / {maxRounds}</strong>
            <div className="round-bar-track" aria-hidden="true">
                <div className="round-bar-fill" style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
}

interface RelicProgressPillProps {
    readonly relics?: RelicPublicSnapshot['relics'];
}

function RelicProgressPill({ relics }: RelicProgressPillProps) {
    if (!relics) {
        return <Status label="Relics" value="-" />;
    }
    const found = relics.filter((r) => r.foundBy).length;
    const escaped = relics.filter((r) => r.escapedBy).length;
    const total = relics.length;
    const pct = total > 0 ? Math.round((found / total) * 100) : 0;
    const escapedPct = total > 0 ? Math.round((escaped / total) * 100) : 0;
    return (
        <div className="status-pill relic-progress-pill">
            <span>Relics</span>
            <strong>{found}/{total}</strong>
            {escaped > 0 && <small>{escaped} safe</small>}
            <div className="relic-bar-track" aria-hidden="true">
                <div className="relic-bar-fill" style={{ width: `${pct}%` }} />
                {escaped > 0 && <div className="relic-bar-escaped" style={{ width: `${escapedPct}%` }} />}
            </div>
        </div>
    );
}
