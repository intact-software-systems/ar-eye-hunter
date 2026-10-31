import { useEffect, useId, useState } from 'react';

import type { RallarPeopleOperations, RallarPerson } from '@shared-web/browser/people/rallar-people-contracts.ts';
import type { RallarRoomMove } from '@shared-web/browser/rooms/move/rallar-room-move.ts';
import type { RallarRoomSummary } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupDirectoryEntry } from '@shared/api/group-directory/group-directory-types.ts';
import { computeGroupMemberPresence } from '@shared/api/group-member-presence.ts';
import type { GroupMove } from '@shared/api/mutation/group-move.ts';
import type { StateScope } from '@shared/api/state-types.ts';

export interface RoomMovePanelProps {
    readonly owner: RallarRoomMove;
    readonly scope: StateScope;
    readonly session: AuthSession | undefined;
    readonly roomId: string | undefined;
    readonly rooms: readonly RallarRoomSummary[];
    readonly destinations: readonly GroupDirectoryEntry[];
    readonly people: Pick<RallarPeopleOperations, 'onChange'>;
    readonly connected: boolean;
    readonly blockedReason: string | null;
}

/** Optional React view; all mutation, recovery and activation behavior belongs to RallarRoomMove. */
export function RoomMovePanel(props: RoomMovePanelProps) {
    const [state, setState] = useState(props.owner.getState());
    const [people, setPeople] = useState<readonly RallarPerson[]>([]);
    const [selected, setSelected] = useState('');
    useEffect(() => props.owner.onChange(setState), [props.owner]);
    useEffect(() => {
        if (!props.connected) {
            setPeople([]);
            return;
        }
        return props.people.onChange((value) => setPeople(value.people), { emitCurrent: true });
    }, [props.people, props.connected]);
    useEffect(() => {
        if (props.connected) {
            void props.owner.start();
        }
        return () => props.owner.stop();
    }, [props.owner, props.connected]);
    const move = state.moves.find((entry) => toMoveKey(entry) === selected) ?? state.moves[0];
    const blocked = props.blockedReason !== null;
    return (
        <section className="panel stack" aria-label="Move together">
            <h3>Move together</h3>
            <p className="muted">
                Each present player confirms. Spectators stay. Old-room membership is kept. Capacity is checked when
                everyone moves.
            </p>
            {blocked && <p>{props.blockedReason}</p>}
            <MoveProposalForm
                owner={props.owner}
                scope={props.scope}
                roomId={props.roomId}
                destinations={props.destinations}
                disabled={state.busy || state.moves.some((entry) => entry.status === 'proposed') || blocked}
                onPropose={() => setSelected('')}
            />
            <MoveHistory moves={state.moves} move={move} onSelect={setSelected} />
            {move && (
                <MoveDecision
                    owner={props.owner}
                    state={state}
                    move={move}
                    session={props.session}
                    blocked={blocked}
                    people={people}
                />
            )}
            {state.error && <p role="alert">{state.error}</p>}
            <button type="button" disabled={state.busy} onClick={() => void props.owner.refresh()}>Refresh move</button>
            <MoveRoomRosters rooms={props.rooms} session={props.session} people={people} />
        </section>
    );
}

interface MoveProposalFormProps extends Pick<RoomMovePanelProps, 'owner' | 'scope' | 'roomId' | 'destinations'> {
    readonly disabled: boolean;
    readonly onPropose: () => void;
}

function MoveProposalForm({ owner, scope, roomId, destinations, disabled, onPropose }: MoveProposalFormProps) {
    const [destination, setDestination] = useState('');
    return (
        <form
            className="stack"
            onSubmit={(event) => {
                event.preventDefault();
                onPropose();
                void owner.propose({ ...scope, groupId: destination.trim() });
            }}
        >
            <label>
                Public destination
                <select
                    value={destinations.some((room) => room.groupRef.groupId === destination) ? destination : ''}
                    onChange={(event) => setDestination(event.target.value)}
                >
                    <option value="">Choose a room or enter its reference</option>
                    {destinations.filter((room) => room.groupRef.groupId !== roomId).map((room) => (
                        <option key={room.groupRef.groupId} value={room.groupRef.groupId}>
                            {room.displayName} · {room.onlinePlayerCount} present{room.isFull ? ' · full' : ''}
                        </option>
                    ))}
                </select>
            </label>
            <label>
                Destination room reference<input
                    value={destination}
                    onChange={(event) => setDestination(event.target.value)}
                    autoComplete="off"
                />
            </label>
            <button type="submit" disabled={disabled || !roomId || !destination.trim()}>Propose move</button>
        </form>
    );
}

interface MoveDecisionProps extends Pick<RoomMovePanelProps, 'owner' | 'session'> {
    readonly state: RallarRoomMove.State;
    readonly move: GroupMove;
    readonly blocked: boolean;
    readonly people: readonly RallarPerson[];
}

function MoveDecision({ owner, state, move, session, blocked, people }: MoveDecisionProps) {
    const participant = move.participants.find((entry) => entry.sessionId === session?.sessionId);
    const arrived = move.participants.filter((entry) => entry.arrivedAtEpochMs !== null).length;
    return (
        <>
            <p>Destination: {move.destination.groupId}</p>
            <p role="status">
                {state.enteringMoveId === move.moveId
                    ? 'Admitted; entering room'
                    : move.status === 'committed'
                    ? `${arrived} of ${move.participants.length} arrived`
                    : `${move.status}${move.reason ? `: ${move.reason}` : ''}`}
            </p>
            {move.admissionFailure && <p role="alert">{move.admissionFailure.message}</p>}
            <MoveCohort move={move} session={session} people={people} />
            {move.status === 'proposed' && participant && (
                <>
                    <MoveConsent
                        owner={owner}
                        move={move}
                        participant={participant}
                        busy={state.busy}
                        blocked={blocked}
                    />
                    {move.organizerSessionId === session?.sessionId && (
                        <>
                            <button
                                type="button"
                                disabled={state.busy || blocked ||
                                    move.participants.some((entry) => entry.confirmedAtEpochMs === null)}
                                onClick={() => void owner.act('commit', move)}
                            >
                                Move everyone
                            </button>
                            <button type="button" disabled={state.busy} onClick={() => void owner.act('cancel', move)}>
                                Cancel move
                            </button>
                        </>
                    )}
                </>
            )}
            {move.status === 'committed' && (!participant || participant.arrivedAtEpochMs === null) &&
                (
                    <button type="button" disabled={state.busy || blocked} onClick={() => void owner.enter(move)}>
                        Retry destination entry
                    </button>
                )}
        </>
    );
}

interface MoveConsentProps extends Pick<MoveDecisionProps, 'owner' | 'move' | 'blocked'> {
    readonly participant: GroupMove['participants'][number];
    readonly busy: boolean;
}

function MoveConsent({ owner, move, participant, busy, blocked }: MoveConsentProps) {
    const [code, setCode] = useState('');
    useEffect(() => setCode(''), [move.moveId, move.status]);
    const confirmed = participant.confirmedAtEpochMs !== null;
    return (
        <>
            <label>
                Destination room code<input
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    autoComplete="off"
                />
            </label>
            <button
                type="button"
                disabled={busy || blocked}
                onClick={() => {
                    void owner.act(confirmed ? 'withdraw' : 'confirm', move, confirmed ? null : code.trim() || null);
                    setCode('');
                }}
            >
                {confirmed ? 'Withdraw confirmation' : 'Confirm move'}
            </button>
            <button type="button" disabled={busy} onClick={() => void owner.act('decline', move)}>Decline move</button>
        </>
    );
}

interface MoveRoomRostersProps extends Pick<RoomMovePanelProps, 'rooms' | 'session'> {
    readonly people: readonly RallarPerson[];
}

function MoveRoomRosters({ rooms, session, people }: MoveRoomRostersProps) {
    return rooms.filter((room) =>
        room.snapshot.members.some((member) => member.principalId === session?.clientId && member.status === 'active')
    ).map((room) => {
        const members = computeGroupMemberPresence(room.snapshot, Date.now());
        const present = members.filter((entry) => entry.presence === 'present').length;
        return (
            <section key={room.roomId} aria-label={`Members of ${room.roomId}`}>
                <h4>{room.name}</h4>
                <p>{present} present · {members.length - present} away</p>
                <ul>
                    {members.map(({ member, presence }) => (
                        <li key={member.principalId}>
                            {toPlayerName(member.principalId, people)} · {presence === 'present' ? 'Present' : 'Away'}
                            {member.role === 'spectator' ? ' · spectator (stays)' : ''}
                        </li>
                    ))}
                </ul>
            </section>
        );
    });
}

function toPlayerName(principalId: string, people: readonly RallarPerson[]): string {
    const person = people.find((entry) => entry.principalId === principalId);
    return person?.displayName || person?.username || principalId;
}

function toMoveKey(move: GroupMove): string {
    return JSON.stringify([move.source.groupId, move.moveId]);
}

function MoveCohort({ move, session, people }: Pick<MoveDecisionProps, 'move' | 'session' | 'people'>) {
    return (
        <ul>
            {move.participants.map((entry) => (
                <li key={entry.sessionId}>
                    {toPlayerName(entry.principalId, people)} ·{' '}
                    {entry.sessionId === session?.sessionId ? 'you' : entry.sessionId.slice(0, 8)} ·{' '}
                    {entry.arrivedAtEpochMs !== null
                        ? 'Arrived'
                        : entry.confirmedAtEpochMs !== null
                        ? 'Confirmed'
                        : 'Waiting'}
                </li>
            ))}
        </ul>
    );
}

interface MoveHistoryProps {
    readonly moves: readonly GroupMove[];
    readonly move: GroupMove | undefined;
    readonly onSelect: (key: string) => void;
}

function MoveHistory({ moves, move, onSelect }: MoveHistoryProps) {
    const historyId = useId();
    if (moves.length <= 1) {
        return null;
    }
    return (
        <>
            <label htmlFor={historyId}>Move history</label>
            <select
                id={historyId}
                value={move ? toMoveKey(move) : ''}
                onChange={(event) => onSelect(event.target.value)}
            >
                {moves.map((entry) => (
                    <option key={toMoveKey(entry)} value={toMoveKey(entry)}>
                        {entry.destination.groupId} · {entry.status}
                    </option>
                ))}
            </select>
        </>
    );
}
