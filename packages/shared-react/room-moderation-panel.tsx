import type { BrowserRallarRooms } from '@shared-web/browser/rooms/browser-rallar-rooms.ts';
import type { RallarRoomEntry } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import type { RallarRoomSession, RallarRoomState } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import { readRoomMembershipRevocation } from '@shared-web/browser/rooms/room-membership-revocation.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef, toScopedRoomKey } from '@shared/api/api-type-utils.ts';
import { computeGroupMemberPresence } from '@shared/api/group-member-presence.ts';
import type { GroupMember, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { startRepeating } from '@shared/resilience/timing/start-repeating.ts';
import { useEffect, useRef, useState } from 'react';

type ModerationAction = 'remove' | 'ban' | 'unban';
interface ModerationSelection {
    readonly action: ModerationAction;
    readonly principalId: string;
}

export interface RoomModerationPanelProps {
    readonly session: AuthSession;
    readonly accessCheckIntervalMs: number;
    readonly rooms: Pick<BrowserRallarRooms, 'state' | 'onChange' | 'removeMember' | 'banMember' | 'unbanMember'> & {
        session(room: GroupRef): Pick<RallarRoomSession, 'refresh'>;
    };
    readonly entry: Pick<RallarRoomEntry, 'cancel'>;
}

export function RoomModerationPanel(props: RoomModerationPanelProps) {
    return <RoomModerationSession key={JSON.stringify([props.session.clientId, props.session.sessionId])} {...props} />;
}

function RoomModerationSession(props: RoomModerationPanelProps) {
    const { session, rooms } = props;
    const { state, notice } = useRoomModerationState(props);
    const snapshot = state?.currentRoom;
    const actor = snapshot?.members.find((member) => member.principalId === session.clientId);
    const governs = actor?.status === 'active' && (actor.role === 'owner' || actor.role === 'admin');
    return (
        <section aria-label="Room moderation" className="panel stack">
            {notice && <p role="alert">{notice}</p>}
            {state && snapshot && governs && (
                <RoomMemberControls
                    key={toScopedRoomKey(snapshot.group)}
                    rooms={rooms}
                    snapshot={snapshot}
                    actor={actor}
                    state={state}
                />
            )}
        </section>
    );
}

interface RoomModerationObservation {
    readonly state: RallarRoomState | undefined;
    readonly notice: string | null;
}

function useRoomModerationState(props: RoomModerationPanelProps): RoomModerationObservation {
    const [state, setState] = useState<RallarRoomState>();
    const observed = useRef<RallarRoomState | undefined>(undefined);
    const [notice, setNotice] = useState<string | null>(null);
    useEffect(() =>
        props.rooms.onChange((next) => {
            const previous = observed.current?.currentRoomRef;
            observed.current = next;
            const revoked = previous && !next.currentRoomRef
                ? next.rooms.find((room) => isSameGroupRef(room.roomRef, previous))?.snapshot.members
                    .find((member) => member.principalId === props.session.clientId)?.status
                : undefined;
            if (previous && (revoked === 'banned' || revoked === 'removed')) {
                props.entry.cancel();
                setNotice(`You were ${revoked} from room ${previous.groupId}. Choose another room.`);
            }
            setState(next);
        }), [props.rooms, props.entry, props.session.clientId]);
    useEffect(() => {
        if (state?.currentRoomRef) {
            setNotice(null);
        }
    }, [state?.currentRoomRef?.applicationId, state?.currentRoomRef?.workspaceId, state?.currentRoomRef?.groupId]);
    useEffect(() => {
        const controller = new AbortController();
        const stop = startRepeating({
            timers: createDefaultTimers(),
            intervalMs: props.accessCheckIntervalMs,
            firstRun: 'after-interval',
            run: () =>
                observed.current ? checkCurrentRoomAccess({ props, signal: controller.signal, setNotice }) : undefined
        });
        return () => {
            controller.abort();
            stop();
        };
    }, [props.rooms, props.entry, props.session.clientId, props.session.sessionId, props.accessCheckIntervalMs]);
    return { state, notice };
}

interface CheckCurrentRoomAccessInput {
    readonly props: RoomModerationPanelProps;
    readonly signal: AbortSignal;
    readonly setNotice: (notice: string) => void;
}

async function checkCurrentRoomAccess({ props, signal, setNotice }: CheckCurrentRoomAccessInput): Promise<void> {
    const room = props.rooms.state().currentRoomRef;
    if (!room) {
        return;
    }
    try {
        await props.rooms.session(room).refresh({ signal, timeoutMs: props.accessCheckIntervalMs });
    }
    catch (error) {
        const revoked = readRoomMembershipRevocation(error);
        console.log('MODERATION READ', revoked, signal.aborted, props.rooms.state().currentRoomRef);
        const current = props.rooms.state().currentRoomRef;
        if (!signal.aborted && revoked && !current) {
            props.entry.cancel();
            setNotice(`You were ${revoked} from room ${room.groupId}. Choose another room.`);
        }
    }
}

interface RoomMemberControlsProps {
    readonly rooms: RoomModerationPanelProps['rooms'];
    readonly snapshot: GroupSnapshot;
    readonly actor: GroupMember;
    readonly state: RallarRoomState;
}

function RoomMemberControls({ rooms, snapshot, actor, state }: RoomMemberControlsProps) {
    const { selection, busy, message, error, select, cancel, confirm } = useModerationCommand(rooms, snapshot);
    const targets = snapshot.members.filter((member) =>
        member.principalId !== actor.principalId && member.role !== 'owner' &&
        (actor.role === 'owner' || member.role !== 'admin')
    );
    return (
        <>
            <h3>Room moderation</h3>
            <ul>
                {targets.map((member) => (
                    <ModerationMember
                        key={member.principalId}
                        member={member}
                        state={state}
                        busy={busy}
                        select={(action) => {
                            select({ action, principalId: member.principalId });
                        }}
                    />
                ))}
            </ul>
            {selection && (
                <ModerationConfirmation
                    selection={selection}
                    busy={busy}
                    confirm={confirm}
                    cancel={cancel}
                />
            )}
            {message && <p role="status">{message}</p>}
            {error && <p role="alert">{error}</p>}
        </>
    );
}

interface ModerationCommandState {
    readonly selection: ModerationSelection | null;
    readonly busy: boolean;
    readonly message: string | null;
    readonly error: string | null;
    select(selection: ModerationSelection): void;
    cancel(): void;
    confirm(): Promise<void>;
}

function useModerationCommand(
    rooms: RoomModerationPanelProps['rooms'],
    snapshot: GroupSnapshot
): ModerationCommandState {
    const [selection, setSelection] = useState<ModerationSelection | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const pending = useRef<AbortController | null>(null);
    useEffect(() => () => pending.current?.abort(), []);
    const confirm = async () => {
        if (!selection || pending.current) {
            return;
        }
        const controller = new AbortController();
        pending.current = controller;
        setBusy(true);
        setError(null);
        try {
            await submitModeration(rooms, snapshot, { selection, signal: controller.signal });
            if (!controller.signal.aborted) {
                setMessage(moderationOutcome(selection));
                setSelection(null);
            }
        }
        catch (cause) {
            if (!controller.signal.aborted) {
                setError(cause instanceof Error ? cause.message : String(cause));
            }
        }
        finally {
            if (!controller.signal.aborted) {
                pending.current = null;
                setBusy(false);
            }
        }
    };
    return {
        selection,
        busy,
        message,
        error,
        confirm,
        select: (next) => {
            setSelection(next);
            setMessage(null);
            setError(null);
        },
        cancel: () => setSelection(null)
    };
}

function moderationOutcome(selection: ModerationSelection): string {
    const outcome = selection.action === 'ban'
        ? 'banned'
        : selection.action === 'unban'
        ? 'unbanned; they must join again'
        : 'removed';
    return `${selection.principalId} was ${outcome}.`;
}

interface ModerationMemberProps {
    readonly member: GroupMember;
    readonly state: RallarRoomState;
    readonly busy: boolean;
    readonly select: (action: ModerationAction) => void;
}

function ModerationMember({ member, state, busy, select }: ModerationMemberProps) {
    const name = state.members.find((entry) => entry.principalId === member.principalId)?.displayName ??
        member.principalId;
    const present = state.currentRoom && computeGroupMemberPresence(state.currentRoom, Date.now())
        .some((entry) => entry.member.principalId === member.principalId && entry.presence === 'present');
    return (
        <li>
            <span>{name} · {member.status === 'active' ? present ? 'Present' : 'Away' : member.status}</span>
            {member.status === 'active' && (
                <button type="button" disabled={busy} onClick={() => select('remove')}>Remove {name}</button>
            )}
            {member.status === 'banned'
                ? <button type="button" disabled={busy} onClick={() => select('unban')}>Unban {name}</button>
                : <button type="button" disabled={busy} onClick={() => select('ban')}>Ban {name}</button>}
        </li>
    );
}

interface ModerationConfirmationProps {
    readonly selection: ModerationSelection;
    readonly busy: boolean;
    readonly confirm: () => Promise<void>;
    readonly cancel: () => void;
}

function ModerationConfirmation({ selection, busy, confirm, cancel }: ModerationConfirmationProps) {
    return (
        <div role="group" aria-label="Confirm moderation">
            <p>{selection.action} {selection.principalId} from this room?</p>
            <p>
                {selection.action === 'unban'
                    ? 'This allows a new admission attempt. It does not join them automatically.'
                    : selection.action === 'remove'
                    ? 'Their sessions lose room access. A new invitation is required to re-enter.'
                    : 'Their sessions lose room access and stop participating until explicitly unbanned.'}
            </p>
            <button type="button" disabled={busy} onClick={() => void confirm()}>Confirm {selection.action}</button>
            <button type="button" disabled={busy} onClick={cancel}>Cancel moderation</button>
        </div>
    );
}

interface ModerationSubmission {
    readonly selection: ModerationSelection;
    readonly signal: AbortSignal;
}

async function submitModeration(
    rooms: RoomModerationPanelProps['rooms'],
    snapshot: GroupSnapshot,
    command: ModerationSubmission
): Promise<GroupSnapshot> {
    const { action, principalId } = command.selection;
    const options = { signal: command.signal };
    if (action === 'ban') {
        return await rooms.banMember(snapshot.group, principalId, options);
    }
    if (action === 'unban') {
        return await rooms.unbanMember(snapshot.group, principalId, options);
    }
    return await rooms.removeMember(snapshot.group, principalId, options);
}
