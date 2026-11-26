import { isRoomGuestAccess } from '@shared/api/room-guests/invitation.ts';
import { decodeExactGroupRef } from '@shared/encoding/decode-exact-group-ref.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import { browserCredentialStore } from '@shared-web/browser/auth/browser-credential-store.ts';
import { createRoomGuestSecret, redeemRoomGuestInvitation } from '@shared-web/browser/rooms/entry/redeem-guest-invitation.ts';
import { RallarRoomEvent } from '@shared-web/browser/rooms/events/rallar-room-event.ts';
import { courtAlertStatus, readCourtAlertLaunch } from '@shared-web/browser/rooms/events/court-alert-notification.ts';
import { disableCourtReadyNotifications, enableCourtReadyNotifications, readCourtAlertPublicKey } from '@shared-web/browser/rooms/events/court-ready-notifications.ts';

const button = (id: string) => document.querySelector<HTMLButtonElement>('#' + id)!;
const join = button('join'), queue = button('queue'), enter = button('enter'), leave = button('leave');
const notify = button('notify'), disable = button('disable');
const status = document.querySelector<HTMLElement>('[role=status]')!;
const notice = document.querySelector<HTMLElement>('#notifications')!;
const error = document.querySelector<HTMLElement>('[role=alert]')!;
const lifetime = new AbortController();
let event: RallarRoomEvent | undefined;
let registered: ServiceWorkerRegistration | undefined;
let publicKey: string | null = null;
let busy = false;

function bind(control: HTMLButtonElement, action: () => Promise<void>): void {
    control.onclick = async () => {
        if (busy) return;
        busy = true;
        error.textContent = '';
        try { await action(); }
        catch (failure) { error.textContent = failure instanceof Error ? failure.message : 'Could not complete the action.'; }
        finally { busy = false; }
    };
}

async function open(): Promise<void> {
    const response = await fetch('./event.json', {cache:'no-store', signal:lifetime.signal});
    if (!response.ok) throw new Error('This event invitation is unavailable.');
    const settings = await response.json();
    const lobby = decodeExactGroupRef(settings.lobby, 'Invited event');
    const apiBaseUrl = settings.apiBaseUrl ?? location.origin;
    const key = 'pickup-event.' + JSON.stringify([apiBaseUrl, lobby.applicationId, lobby.workspaceId, lobby.groupId]);
    const launch = readCourtAlertLaunch(new URL(location.href));
    rallar.configure({ apiBaseUrl });
    rallar.setDefaults({ applicationId: lobby.applicationId, workspaceId: lobby.workspaceId });
    const isIphoneBrowser = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const needsInstall = isIphoneBrowser && !matchMedia('(display-mode: standalone)').matches;
    if (needsInstall) notice.textContent = 'For alerts on a future visit, add this app to your Home Screen and open it there before joining.';
    else if ('PushManager' in window && 'serviceWorker' in navigator && 'Notification' in window) {
        try {
            publicKey = await readCourtAlertPublicKey(lifetime.signal);
            if (publicKey) {
                await navigator.serviceWorker.register('./worker.js', { type: 'module', scope: './' });
                registered = await navigator.serviceWorker.ready;
            }
        } catch {
            notice.textContent = 'Alerts are unavailable in this browser. You can still join the queue.';
        }
    }

    async function joinEvent(): Promise<void> {
        const saved = await browserCredentialStore.read(key + '.seat');
        let access = saved ? JSON.parse(saved) : null;
        if (!isRoomGuestAccess(access)) {
            const secret = await browserCredentialStore.readOrCreate(key + '.secret', createRoomGuestSecret());
            const requestId = await browserCredentialStore.readOrCreate(key + '.request', crypto.randomUUID());
            access = await redeemRoomGuestInvitation(lobby, { invitationSecret: settings.invitationSecret, guestSecret: secret },
                { requestId, signal: lifetime.signal });
            await browserCredentialStore.write(key + '.seat', JSON.stringify(access));
        }
        await rallar.auth.activateGuest({room:lobby, access, username:'Pickup player'});
        await rallar.connect({signal:lifetime.signal});
        await rallar.rooms.join(lobby, {presenceOnly:true, signal:lifetime.signal, preserveCurrentMembership:true});
        const resource = new RallarRoomEvent(rallar, lobby);
        event = resource;
        join.hidden = true;
        let inCourt = false;
        resource.onChange(({view, busy: working, error: failure}) => {
            if (failure) error.textContent = failure;
            if (!view || view.closed) {
                queue.hidden = leave.hidden = enter.hidden = notify.hidden = disable.hidden = true;
                status.textContent = view?.closed ? 'Event closed.' : 'Recovering your event…';
                return;
            }
            const offered = view.offer;
            const alertStatus = courtAlertStatus(launch, view, rallar.deadlineAfter(0));
            const current = offered ? (offered.deadline === null ? 'Court assigned: ' : 'Your court is ready: ') + offered.groupId :
                view.queue ? 'Waiting for a court.' : 'Ready to join the queue.';
            status.textContent = (alertStatus === 'expired' ? 'Your earlier offer has expired. ' : '') + current;
            queue.hidden = !!offered || !!view.queue;
            leave.hidden = !view.queue;
            enter.hidden = !offered || (inCourt && offered.deadline === null);
            enter.textContent = offered ? 'Enter ' + offered.groupId : 'Enter court';
            notify.hidden = !registered || !publicKey;
            disable.hidden = !registered || Notification.permission !== 'granted';
            for (const control of [queue, leave, enter, notify, disable]) control.disabled = working;
        });
        await resource.start();
        bind(queue, async () => {
            await resource.act({ action:'propose', partyId:crypto.randomUUID(), players:[access.clientId] });
            inCourt = false;
        });
        bind(leave, () => resource.act({action:'leave-queue'}));
        bind(enter, async () => { await resource.enterCourt(); inCourt = true; enter.hidden = true; });
        bind(notify, async () => {
            const result = await enableCourtReadyNotifications(resource, registered!.pushManager, publicKey!);
            notice.textContent = result === 'enabled' ? 'Court alerts are on for this event.' : 'Permission was declined. You can still join the queue.';
            disable.hidden = result !== 'enabled';
        });
        bind(disable, async () => {
            await disableCourtReadyNotifications(resource, registered!.pushManager);
            notice.textContent = 'Court alerts are off for this event.';
        });
    }
    if (await browserCredentialStore.read(key + '.seat')) await joinEvent();
    else {
        status.textContent = 'Join this pickup event to queue for a court.';
        join.hidden = false;
        bind(join, joinEvent);
    }
}

window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    lifetime.abort();
    void rallar.disconnect();
}, {once:true});
lifetime.signal.addEventListener('abort', () => event?.stop(), {once:true});
void open().catch(failure => { error.textContent = failure instanceof Error ? failure.message : 'Event unavailable.'; });
