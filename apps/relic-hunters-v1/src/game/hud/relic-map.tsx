import {
    findRelicCharacter,
    type RelicEvent,
    type RelicPlayer,
    type RelicPublicSnapshot,
    type RelicRoom
} from '@relic-hunters/mod.ts';

import { plural } from '../lang.ts';
import { shortestOpenRoomPath } from '../scene/objectives.ts';
import {
    calculateFacilityBounds,
    projectFacilityMapPoint,
    shouldShowFacilityMapLabel,
    type FacilityBounds,
    type FacilityPoint
} from '../scene/relicSceneNextModel.ts';

interface CastleMapProps {
    readonly snapshot: RelicPublicSnapshot;
    readonly localPlayerId?: string;
    readonly selectedRoomId?: string;
    readonly lastEvent?: RelicEvent;
    onSelectRoom(roomId: string): void;
}

export function CastleMap(props: CastleMapProps) {
    const { snapshot, localPlayerId } = props;
    const bounds = calculateFacilityBounds(snapshot.map);
    const exitDistances = castleMapExitDistances(snapshot.map);
    const localPlayer = snapshot.players.find((player) => player.playerId === localPlayerId);
    return (
        <div id="hud-map" className="panel castle-map-panel">
            <div className="castle-map-title">
                <span className="panel-label">Castle Map</span>
                <strong>{snapshot.phase === 'lobby' ? 'Choose a hunter to enter' : 'Track the expedition'}</strong>
            </div>
            <div className="castle-map" aria-label="Castle room map">
                <svg viewBox="0 0 100 100" aria-hidden="true">
                    <CastleMapLines links={castleMapLinks(snapshot.map)} bounds={bounds} />
                    <CastleMapLines links={castleMapTrails(snapshot, localPlayer)} bounds={bounds} />
                    <CastleMapRelics snapshot={snapshot} bounds={bounds} />
                </svg>
                {snapshot.map.map((room) => (
                    <CastleMapRoom
                        key={room.id}
                        room={room}
                        bounds={bounds}
                        exitDistance={exitDistances.get(room.id)}
                        localPlayer={localPlayer}
                        {...props}
                    />
                ))}
                <CastleMapHunters
                    snapshot={snapshot}
                    localPlayerId={localPlayerId}
                    lastEvent={props.lastEvent}
                    bounds={bounds}
                />
            </div>
        </div>
    );
}

interface CastleMapLink {
    readonly from: RelicRoom;
    readonly to: RelicRoom;
    readonly className: string;
}

function castleMapLinks(rooms: readonly RelicRoom[]): readonly CastleMapLink[] {
    const links: CastleMapLink[] = [];
    for (const room of rooms) {
        for (const neighborId of room.neighbors) {
            const neighbor = rooms.find((candidate) => candidate.id === neighborId);
            if (neighbor && room.id < neighborId) {
                links.push({ from: room, to: neighbor, className: '' });
            }
        }
    }
    return links;
}

function castleMapTrails(
    snapshot: RelicPublicSnapshot,
    localPlayer: RelicPlayer | undefined
): readonly CastleMapLink[] {
    const links: CastleMapLink[] = [];
    const exit = snapshot.map.find((room) => room.kind === 'exit');
    const path = exit && localPlayer && localPlayer.relicIds.length > 0 && !localPlayer.escaped && !localPlayer.defeated
        ? shortestOpenRoomPath(snapshot.map, localPlayer.roomId, exit.id)
        : undefined;
    for (let index = 0; path && index < path.length - 1; index += 1) {
        const from = snapshot.map.find((room) => room.id === path[index]);
        const to = snapshot.map.find((room) => room.id === path[index + 1]);
        if (from && to) {
            links.push({ from, to, className: 'castle-map-exit-route' });
        }
    }
    for (const investigation of snapshot.roomInvestigations) {
        const from = snapshot.map.find((room) => room.id === investigation.roomId);
        const to = snapshot.map.find((room) => room.id === investigation.revealedRoomId);
        if (from && to) {
            links.push({ from, to, className: 'castle-map-clue-trail' });
        }
    }
    return links;
}

interface CastleMapLinesProps {
    readonly links: readonly CastleMapLink[];
    readonly bounds: FacilityBounds;
    readonly className?: string;
}

function CastleMapLines({ links, bounds, className }: CastleMapLinesProps) {
    return (
        <>
            {links.map((link) => {
                const from = projectFacilityMapPoint(link.from, bounds);
                const to = projectFacilityMapPoint(link.to, bounds);
                return (
                    <line
                        key={`${link.className}:${link.from.id}:${link.to.id}`}
                        className={className ?? link.className}
                        x1={from.x}
                        y1={from.y}
                        x2={to.x}
                        y2={to.y}
                    />
                );
            })}
        </>
    );
}

interface CastleMapLayerProps {
    readonly snapshot: RelicPublicSnapshot;
    readonly bounds: FacilityBounds;
}

function CastleMapRelics({ snapshot, bounds }: CastleMapLayerProps) {
    return (
        <>
            {snapshot.relics.filter((relic) => !relic.carriedBy && !relic.escapedBy && relic.foundBy && relic.roomId)
                .map((relic) => {
                    const room = snapshot.map.find((candidate) => candidate.id === relic.roomId);
                    if (!room) {
                        return null;
                    }
                    const point = projectFacilityMapPoint(room, bounds);
                    return <circle key={relic.id} className="castle-map-relic-dot" cx={point.x} cy={point.y} r="3.8" />;
                })}
        </>
    );
}

interface CastleMapRoomProps extends CastleMapProps {
    readonly room: RelicRoom;
    readonly bounds: FacilityBounds;
    readonly exitDistance: number | undefined;
    readonly localPlayer: RelicPlayer | undefined;
}

function CastleMapRoom(props: CastleMapRoomProps) {
    const { snapshot, room, bounds, onSelectRoom, exitDistance } = props;
    const point = projectFacilityMapPoint(room, bounds);
    const occupants = snapshot.players.filter((player) =>
        player.roomId === room.id && !player.escaped && !player.defeated
    );
    return (
        <button
            type="button"
            className={castleMapRoomClasses(props, occupants)}
            style={{ left: `${point.x}%`, top: `${point.y}%`, background: roomKindMapColor(room) }}
            onClick={() => onSelectRoom(room.id)}
        >
            <span className="castle-map-room-name">{room.name}</span>
            {exitDistance !== undefined && (
                <span
                    className={`castle-map-exit-dist ${room.kind === 'exit' ? 'at-exit' : ''}`}
                    aria-label={`${exitDistance} steps from exit`}
                >
                    {exitDistance}
                </span>
            )}
            <CastleMapOccupants occupants={occupants} room={room} />
        </button>
    );
}

function castleMapRoomClasses(props: CastleMapRoomProps, occupants: readonly RelicPlayer[]): string {
    const { snapshot, room, localPlayer, selectedRoomId } = props;
    const localRoom = snapshot.map.find((candidate) => candidate.id === localPlayer?.roomId);
    const choosing = snapshot.phase === 'planning' && localPlayer && !localPlayer.escaped && !localPlayer.defeated &&
        !snapshot.submittedPlayerIds.includes(localPlayer.playerId);
    const labelVisible = shouldShowFacilityMapLabel({
        room,
        selectedRoomId,
        localRoomId: localRoom?.id,
        exitRoomId: snapshot.map.find((candidate) => candidate.kind === 'exit')?.id
    });
    return [
        'castle-map-room',
        room.id === selectedRoomId ? 'selected' : '',
        localPlayer?.roomId === room.id ? 'local' : '',
        choosing && !room.collapsed && localRoom?.neighbors.includes(room.id) ? 'reachable' : '',
        occupants.length ? 'occupied' : '',
        occupants.some((player) => player.playerId !== localPlayer?.playerId) ? 'has-others' : '',
        snapshot.roomInvestigations.some((investigation) => investigation.revealedRoomId === room.id)
            ? 'clue-target'
            : '',
        room.unstable ? 'unstable' : '',
        room.collapsed ? 'collapsed' : '',
        labelVisible ? 'label-visible' : ''
    ].filter(Boolean).join(' ');
}

interface CastleMapOccupantsProps {
    readonly occupants: readonly RelicPlayer[];
    readonly room: RelicRoom;
}

function CastleMapOccupants({ occupants, room }: CastleMapOccupantsProps) {
    if (occupants.length === 0) {
        return null;
    }
    return (
        <>
            <span
                className="castle-map-occupancy"
                aria-label={`${occupants.length} ${plural('hunter', occupants.length)} in ${room.name}`}
            >
                {occupants.length}
            </span>
            <span className="castle-map-occupant-dots" aria-hidden="true">
                {occupants.slice(0, 4).map((player) => (
                    <span
                        key={player.playerId}
                        style={{ background: findRelicCharacter(player.characterId).colors.accent }}
                    />
                ))}
            </span>
        </>
    );
}

interface CastleMapHuntersProps extends CastleMapLayerProps {
    readonly localPlayerId?: string;
    readonly lastEvent?: RelicEvent;
}

function CastleMapHunters({ snapshot, bounds, localPlayerId, lastEvent }: CastleMapHuntersProps) {
    return (
        <>
            {snapshot.players.map((player, index) => {
                const room = snapshot.map.find((candidate) => candidate.id === player.roomId);
                if (!room || player.escaped || player.defeated) {
                    return null;
                }
                const point = projectFacilityMapPoint(room, bounds);
                const offset = castleMapPlayerOffset(index);
                const moved = lastEvent?.type === 'player_moved' &&
                    lastEvent.animationCue?.playerId === player.playerId;
                const character = findRelicCharacter(player.characterId);
                return (
                    <span
                        key={player.playerId}
                        className={[
                            'castle-map-hunter',
                            player.playerId === localPlayerId ? 'local' : '',
                            moved ? 'recent-move' : ''
                        ].filter(Boolean).join(' ')}
                        style={{
                            left: `${point.x + offset.x}%`,
                            top: `${point.y + offset.y}%`,
                            background: character.colors.accent
                        }}
                        title={`${player.username}: ${character.name}`}
                    />
                );
            })}
        </>
    );
}

export function castleMapExitDistances(map: RelicPublicSnapshot['map']): Map<string, number> {
    const exit = map.find((room) => room.kind === 'exit');
    const distances = new Map<string, number>();
    if (!exit) {
        return distances;
    }
    const queue: Array<readonly [RelicRoom, number]> = [[exit, 0]];
    distances.set(exit.id, 0);
    for (const [room, distance] of queue) {
        for (const neighborId of room.neighbors) {
            const neighbor = map.find((candidate) => candidate.id === neighborId);
            if (neighbor && !neighbor.collapsed && !distances.has(neighborId)) {
                distances.set(neighborId, distance + 1);
                queue.push([neighbor, distance + 1]);
            }
        }
    }
    return distances;
}

function castleMapPlayerOffset(index: number): FacilityPoint {
    const angle = Math.PI * 2 * index / 4;
    return { x: Math.cos(angle) * 2.6, y: Math.sin(angle) * 2.6 };
}

function roomKindMapColor(room: RelicRoom): string {
    if (room.collapsed) {
        return '#514a3f';
    }
    if (room.unstable) {
        return '#df7a4560';
    }
    switch (room.kind) {
        case 'exit':
            return '#7dd3fc30';
        case 'treasure':
            return '#b7e66e30';
        case 'shrine':
            return '#b9a7f430';
        case 'monster':
            return '#b86f7f30';
        case 'trap':
            return '#f19a6430';
        case 'storage':
            return '#c69b5f30';
        default:
            return '#93b7aa18';
    }
}

interface SceneMinimapOverlayProps {
    readonly snapshot: RelicPublicSnapshot;
    readonly localPlayerId?: string;
}

export function SceneMinimapOverlay({ snapshot, localPlayerId }: SceneMinimapOverlayProps) {
    if (snapshot.phase === 'lobby') {
        return null;
    }
    const bounds = calculateFacilityBounds(snapshot.map);
    const localRoomId = snapshot.players.find((player) => player.playerId === localPlayerId)?.roomId;
    return (
        <div className="scene-minimap" aria-hidden="true">
            <svg viewBox="0 0 100 100">
                <CastleMapLines links={castleMapLinks(snapshot.map)} bounds={bounds} className="minimap-edge" />
                {snapshot.map.map((room) => {
                    const point = projectFacilityMapPoint(room, bounds);
                    const local = room.id === localRoomId;
                    return (
                        <circle
                            key={room.id}
                            cx={point.x}
                            cy={point.y}
                            r={local ? 4.5 : 2.8}
                            className={[
                                'minimap-room',
                                `minimap-${room.kind}`,
                                local ? 'minimap-local' : '',
                                room.collapsed ? 'minimap-collapsed' : ''
                            ].filter(Boolean).join(' ')}
                        />
                    );
                })}
                <SceneMinimapHunters snapshot={snapshot} localPlayerId={localPlayerId} bounds={bounds} />
            </svg>
        </div>
    );
}

function SceneMinimapHunters({ snapshot, localPlayerId, bounds }: CastleMapHuntersProps) {
    return (
        <>
            {snapshot.players.filter((player) =>
                !player.escaped && !player.defeated && player.playerId !== localPlayerId
            ).map((player) => {
                const room = snapshot.map.find((candidate) => candidate.id === player.roomId);
                if (!room) {
                    return null;
                }
                const point = projectFacilityMapPoint(room, bounds);
                return (
                    <circle
                        key={player.playerId}
                        cx={point.x}
                        cy={point.y}
                        r={2.2}
                        fill={findRelicCharacter(player.characterId).colors.accent}
                        className="minimap-player"
                    />
                );
            })}
        </>
    );
}
