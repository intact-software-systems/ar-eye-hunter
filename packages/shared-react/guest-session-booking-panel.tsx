import type { GroupSessionPreview } from '@shared/api/group-sessions/group-session-schedule.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { BrowserActivity } from '@shared-web/browser/browser-activity.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import type { RallarRoomEntry } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import { GuestSessionBooking } from '@shared-web/browser/rooms/sessions/guest-session-booking.ts';
import { useEffect, useRef, useState } from 'react';

/** Render with a key scoped to the saved destination. Guests review a time before granting any game access. */
export function GuestSessionBookingPanel({ room, entry }: { readonly room: GroupRef; readonly entry: RallarRoomEntry }) {
    const [booking] = useState(() => new GuestSessionBooking(room));
    const [preview, setPreview] = useState<GroupSessionPreview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const generation = useRef<AbortController | null>(null);
    const changing = useRef(false);

    async function refresh() {
        if (changing.current) return;
        generation.current?.abort();
        const controller = new AbortController();
        generation.current = controller;
        try {
            const view = await booking.preview(controller.signal);
            if (!controller.signal.aborted) { setPreview(view); setError(null); }
        } catch (failure) {
            if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
        }
    }
    useEffect(() => {
        void refresh();
        const activity = new BrowserActivity();
        const stop = activity.onChange(() => { if (activity.isActive()) void refresh(); });
        return () => { generation.current?.abort(); stop(); };
    }, [booking]);

    async function decide(action: 'reserve' | 'withdraw' | 'claim') {
        if (!preview || changing.current) return;
        generation.current?.abort();
        const controller = new AbortController();
        generation.current = controller;
        changing.current = true;
        setBusy(true);
        setError(null);
        try {
            if (action === 'claim') {
                const access = await booking.claim(preview.schedule.revision, controller.signal);
                controller.signal.throwIfAborted();
                entry.enterScheduledLobby();
                await rallar.auth.activateGuest({ room, access, username: 'Guest' });
            } else {
                await booking.change(action, preview.schedule.revision, controller.signal);
                setPreview(await booking.preview(controller.signal));
            }
        } catch (failure) {
            if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            changing.current = false;
            if (!controller.signal.aborted) setBusy(false);
        }
    }
    if (!preview && !error) return null;
    return <section className="panel stack" aria-label="Guest reservation">
        {preview && <>
            <h4>{preview.displayName}</h4>
            <p>Starts {new Date(preview.schedule.startsAtEpochMs).toLocaleString()}</p>
            {preview.participation === 'reserved' || preview.participation === 'admitted' ? <>
                <p>Your lobby seat is reserved.</p>
                <button type="button" disabled={busy || !preview.canEnter} onClick={() => void decide('claim')}>Claim my lobby seat</button>
                {preview.participation === 'reserved' && <button type="button" disabled={busy} onClick={() => void decide('withdraw')}>Withdraw guest reservation</button>}
            </> : <>
                {preview.participation === 'needs-confirmation' && <p>The organizer changed the schedule. Review the new time to reserve again.</p>}
                <p>{preview.timing.phase === 'cancelled' ? 'The organizer cancelled this session.'
                    : preview.timing.phase === 'reservations-expired' ? 'The reservation deadline has passed.'
                    : 'Return in this browser to claim your seat.'}</p>
                <button type="button" disabled={busy || !preview.canReserve} onClick={() => void decide('reserve')}>Reserve as a guest</button>
            </>}
        </>}
        {error && <p role="alert">{error}</p>}
        <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh availability</button>
    </section>;
}
