import type {
    RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import { findRelicCharacter } from '@relic-hunters/mod.ts';
import { useState } from 'react';
import { roomName } from '../lang.ts';

interface RoomIntelProps {
    readonly currentRoom?: RelicPublicSnapshot['map'][number];
    readonly moveTargets: readonly string[];
    readonly snapshot?: RelicPublicSnapshot;
}

export function RoomIntel({
    currentRoom,
    moveTargets,
    snapshot
}: RoomIntelProps) {
    const [open, setOpen] = useState(false);
    return (
        <div id="hud-intel" className="panel stack room-intel">
            <button type="button" className="collapsible-header" onClick={() => setOpen((v) => !v)}>
                <div>
                    <span className="panel-label">Current Room</span>
                    <strong>{currentRoom?.name ?? 'No hunter in the ruin'}</strong>
                </div>
                <span className="collapse-chevron">{open ? '▲' : '▼'}</span>
            </button>
            {open && currentRoom && (
                <>
                    <div className="tag-row">
                        <span className={`tag ${currentRoom.unstable ? 'danger' : ''}`}>
                            {currentRoom.unstable ? 'unstable' : 'stable'}
                        </span>
                        <span className={`tag ${currentRoom.collapsed ? 'danger' : ''}`}>
                            {currentRoom.collapsed ? 'collapsed' : currentRoom.kind}
                        </span>
                    </div>
                    <RoomIntelFindings currentRoom={currentRoom} moveTargets={moveTargets} snapshot={snapshot} />
                </>
            )}
        </div>
    );
}

interface ClueJournalProps {
    readonly snapshot: RelicPublicSnapshot;
    onSelectRoom(roomId: string): void;
}

export function ClueJournal({
    snapshot,
    onSelectRoom
}: ClueJournalProps) {
    const [open, setOpen] = useState(true);
    const investigations = [...(snapshot.roomInvestigations ?? [])]
        .sort((left, right) => right.searchedAtRound - left.searchedAtRound);

    if (investigations.length === 0) {
        return null;
    }

    return (
        <div className="panel stack clue-journal" aria-label="Discovered clue trails">
            <button type="button" className="collapsible-header" onClick={() => setOpen((v) => !v)}>
                <div>
                    <span className="panel-label">Discovered Trails</span>
                    <strong>{investigations.length} marked clue{investigations.length === 1 ? '' : 's'}</strong>
                </div>
                <span className="collapse-chevron">{open ? '▲' : '▼'}</span>
            </button>
            {open && (
                <div className="clue-journal-list">
                    {investigations.map((investigation) => {
                        const room = snapshot.map.find((candidate) => candidate.id === investigation.roomId);
                        const target = investigation.revealedRoomId
                            ? snapshot.map.find((candidate) => candidate.id === investigation.revealedRoomId)
                            : undefined;
                        return (
                            <button
                                type="button"
                                key={`${investigation.roomId}-${investigation.searchedAtRound}`}
                                className={`clue-journal-entry${target ? ' has-target' : ''}`}
                                onClick={() => onSelectRoom(target?.id ?? investigation.roomId)}
                            >
                                <span>
                                    Round {investigation.searchedAtRound} · {investigation.searchedByUsername}
                                </span>
                                <strong>
                                    {room?.name ?? investigation.roomId}
                                    {target ? ` - ${target.name}` : ' - no target'}
                                </strong>
                                <small>{investigation.summary}</small>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

interface RoomDetailCardProps {
    readonly snapshot: RelicPublicSnapshot;
    readonly roomId: string;
    readonly localPlayerId?: string;
    readonly exitDistances: Map<string, number>;
    onPrimeMove(roomId: string): void;
    onDismiss(): void;
}

export function RoomDetailCard({
    snapshot,
    roomId,
    localPlayerId,
    exitDistances,
    onPrimeMove,
    onDismiss
}: RoomDetailCardProps) {
    const room = snapshot.map.find((r) => r.id === roomId);
    if (!room) {
        return null;
    }

    const localPlayer = snapshot.players.find((p) => p.playerId === localPlayerId);
    const localRoom = localPlayer ? snapshot.map.find((r) => r.id === localPlayer.roomId) : undefined;
    const isReachable = !room.collapsed && !!(localRoom?.neighbors.includes(roomId));
    const isCurrentRoom = localPlayer?.roomId === roomId;
    const canPrimeMove = isReachable &&
        !isCurrentRoom &&
        snapshot.phase === 'planning' &&
        !!localPlayer &&
        !localPlayer.escaped &&
        !localPlayer.defeated &&
        !snapshot.submittedPlayerIds.includes(localPlayer.playerId);
    const dist = exitDistances.get(roomId);

    return (
        <div className="panel room-detail-card">
            <div className="room-detail-header">
                <strong>{room.name}</strong>
                <span className={`room-kind-pill room-kind-${room.kind}`}>{room.kind}</span>
                {dist !== undefined && <span className="room-detail-dist">{dist}→exit</span>}
                <button
                    type="button"
                    className="room-detail-close"
                    aria-label="Close room detail"
                    onClick={onDismiss}
                >
                    ×
                </button>
            </div>
            {room.collapsed && <p className="room-detail-status danger">This room has collapsed.</p>}
            {room.unstable && !room.collapsed && (
                <p className="room-detail-status warn">Unstable — may collapse next round.</p>
            )}
            <RoomDetailFindings snapshot={snapshot} roomId={roomId} />
            {canPrimeMove && (
                <button type="button" className="primary" onClick={() => onPrimeMove(roomId)}>
                    Prime Move → {room.name}
                </button>
            )}
        </div>
    );
}

function RoomIntelFindings({ currentRoom, moveTargets, snapshot }: RoomIntelProps) {
    const roomRelics = currentRoom && snapshot
        ? snapshot.relics.filter((relic) => relic.roomId === currentRoom.id && !relic.carriedBy && !relic.escapedBy)
        : [];
    const investigation = currentRoom && snapshot
        ? snapshot.roomInvestigations?.find((candidate) => candidate.roomId === currentRoom.id)
        : undefined;
    const revealedRoom = investigation?.revealedRoomId && snapshot
        ? snapshot.map.find((room) => room.id === investigation.revealedRoomId)
        : undefined;
    return (
        <div className="intel-grid">
            <div>
                <span>Paths</span>
                <strong>
                    {moveTargets.length > 0
                        ? moveTargets.map((roomId) => roomName(snapshot, roomId)).join(', ')
                        : 'none'}
                </strong>
            </div>
            <div>
                <span>Relic Signal</span>
                <strong>
                    {roomRelics.length > 0
                        ? roomRelics.map((relic) => relic.name).join(', ')
                        : investigation
                        ? investigation.result === 'relic-found'
                            ? 'relic trail marked'
                            : 'searched clear'
                        : 'quiet stone'}
                </strong>
            </div>
            <div>
                <span>Investigation</span>
                <strong>
                    {investigation
                        ? investigation.summary
                        : 'unmarked'}
                </strong>
            </div>
            {investigation && (
                <div>
                    <span>Clue Note</span>
                    <strong>{investigation.danger ?? investigation.hint}</strong>
                </div>
            )}
            {revealedRoom && (
                <div>
                    <span>Clue Target</span>
                    <strong>{revealedRoom.name}</strong>
                </div>
            )}
        </div>
    );
}
interface RoomDetailFindingsProps {
    readonly snapshot: RelicPublicSnapshot;
    readonly roomId: string;
}
function RoomDetailFindings({ snapshot, roomId }: RoomDetailFindingsProps) {
    const occupants = snapshot.players.filter(
        (p) => p.roomId === roomId && !p.escaped && !p.defeated
    );
    const investigations = (snapshot.roomInvestigations ?? []).filter(
        (inv) => inv.roomId === roomId
    );
    const foundRelics = snapshot.relics.filter(
        (r) => r.roomId === roomId && r.foundBy && !r.carriedBy && !r.escapedBy
    );
    return (
        <>
            {occupants.length > 0 && (
                <div className="room-detail-occupants">
                    {occupants.map((player) => {
                        const char = findRelicCharacter(player.characterId);
                        return (
                            <span
                                key={player.playerId}
                                className="room-detail-occupant"
                                style={{ borderColor: char.colors.accent }}
                            >
                                {player.username}
                                {player.relicIds.length > 0 && ` ◆${player.relicIds.length}`}
                            </span>
                        );
                    })}
                </div>
            )}
            {investigations.map((inv) => (
                <div key={`${inv.roomId}-${inv.searchedAtRound}`} className="room-detail-intel">
                    <em>{inv.searchedByUsername} searched round {inv.searchedAtRound}</em>
                    <span>{inv.summary}</span>
                    {inv.hint && <small>{inv.hint}</small>}
                </div>
            ))}
            {foundRelics.map((r) => <div key={r.id} className="room-detail-relic">◆ {r.name} — unclaimed</div>)}
        </>
    );
}
