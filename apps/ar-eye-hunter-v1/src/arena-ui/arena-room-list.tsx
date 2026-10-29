import { toGroupDirectoryListing } from '@shared/api/group-directory/group-directory-listing.ts';
import type { GroupDirectoryEntry } from '@shared/api/group-directory/group-directory-types.ts';
import { countOnlineGroupPlayers, isGroupSpectator } from '@shared/api/group-spectating.ts';

import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';

interface ArenaRoomListProps {
    readonly arena: ArenaConnection;
}

function ArenaLatencyPreference({ arena }: ArenaRoomListProps) {
    return (
        <>
            <label className="directory-latency-preference">
                <input
                    type="checkbox"
                    checked={arena.directoryOrder === 'peer-rtt'}
                    onChange={(event) =>
                        void arena.changeDirectoryOrder(event.target.checked ? 'peer-rtt' : 'online-members')}
                />
                Prefer lower peer latency
            </label>
            {arena.directoryOrder === 'peer-rtt' && (
                <p className="muted">
                    Occupancy comes first. Recent peer RTT breaks ties; unmeasured rooms stay available.
                </p>
            )}
        </>
    );
}

export function ArenaRoomList({ arena }: ArenaRoomListProps) {
    const rooms = arena.rooms.filter((room) =>
        room.name.toLowerCase().includes('eye hunter') &&
        ((room.joinMode === 'open' && toGroupDirectoryListing(room.snapshot.group.metadata) === 'listed') ||
            room.snapshot.members.some((member) =>
                member.principalId === arena.session?.clientId && member.status === 'active'
            ))
    );
    return (
        <>
            {arena.roomId && (
                <div className="room-actions">
                    {arena.spectating && (
                        <>
                            <strong>Watching</strong>
                            <button type="button" onClick={() => void arena.joinAsPlayer()}>Join as player</button>
                        </>
                    )}
                    <button type="button" onClick={() => void arena.leaveRoom()}>Leave arena</button>
                </div>
            )}
            <ArenaLatencyPreference arena={arena} />
            <div className="room-list">
                {arena.openRoomsStatus === 'loading' && <p className="muted">Loading open arenas…</p>}
                {arena.openRoomsStatus === 'ready' && rooms.length === 0 && arena.openRooms.length === 0 && (
                    <p className="muted">Create an arena or join from another browser session.</p>
                )}
                {arena.openRoomsStatus === 'error' && (
                    <p className="muted">Could not load open arenas: {arena.openRoomsError}</p>
                )}
                {arena.openRoomsStatus !== 'ready' && arena.openRooms.length > 0 && (
                    <p className="muted">Last loaded arenas — refresh to check availability.</p>
                )}
                {rooms.map((room) => (
                    <button
                        type="button"
                        key={room.roomId}
                        data-room-id={room.roomId}
                        className={room.roomId === arena.roomId ? 'room-row active' : 'room-row'}
                        onClick={() => arena.joinRoom(room.roomId)}
                    >
                        <span>{room.name}</span>
                        <small>
                            {countOnlineGroupPlayers(room.snapshot)} players online ·{' '}
                            {room.snapshot.members.filter(isGroupSpectator).length} watching
                        </small>
                    </button>
                ))}
                {arena.openRooms.length > 0 && <p className="muted">Open arenas</p>}
                {arena.openRooms.map((room) => (
                    <ArenaDirectoryRoom key={room.groupRef.groupId} arena={arena} room={room} />
                ))}
            </div>
        </>
    );
}

interface ArenaDirectoryRoomProps extends ArenaRoomListProps {
    readonly room: GroupDirectoryEntry;
}

function ArenaDirectoryRoom({ arena, room }: ArenaDirectoryRoomProps) {
    return (
        <div key={room.groupRef.groupId}>
            <button
                type="button"
                key={room.groupRef.groupId}
                data-room-id={room.groupRef.groupId}
                className="room-row"
                disabled={room.isFull}
                onClick={() => arena.joinRoom(room.groupRef.groupId)}
            >
                <span>{room.displayName}</span>
                <small>
                    {room.isFull ? 'Full · ' : ''}
                    {room.onlinePlayerCount} players online · {room.spectatorCount}{' '}
                    watching{room.isFull ? '' : ' · Request to join'}
                    {arena.directoryOrder === 'peer-rtt' && (
                        <>
                            <br />
                            {room.peerRttMs === null
                                ? 'Peer latency unknown'
                                : `${Math.round(room.peerRttMs)} ms peer RTT`}
                        </>
                    )}
                </small>
            </button>
            {room.maxSpectators > 0 && (
                <button
                    type="button"
                    aria-label={`Watch ${room.displayName}`}
                    disabled={room.spectatorCount >= room.maxSpectators}
                    onClick={() => void arena.watchRoom(room.groupRef.groupId)}
                >
                    Watch · {room.spectatorCount}/{room.maxSpectators}
                </button>
            )}
        </div>
    );
}
