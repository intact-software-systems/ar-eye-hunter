import { pickupStatus } from './pickup-status.ts';
import { followPickupAlert } from './follow-pickup-alert.ts';
import { openPickupInvitation, joinPickupLobby } from './pickup-invitation.ts';
import { preparePickupAlerts, showInstalledAlertSupport } from './pickup-alerts.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import { browserCredentialStore } from '@shared-web/browser/auth/browser-credential-store.ts';
import { RallarRoomEvent } from '@shared-web/browser/rooms/events/rallar-room-event.ts';
import { courtAlertStatus } from '@shared-web/browser/rooms/events/court-alert-notification.ts';
import { disableCourtReadyNotifications, enableCourtReadyNotifications } from '@shared-web/browser/rooms/events/court-ready-notifications.ts';

const button = (id: string) => document.querySelector<HTMLButtonElement>('#' + id)!;
const join = button('join'), queue = button('queue'), enter = button('enter'), leave = button('leave');
const notify = button('notify'), disable = button('disable'), retry = button('retry');
const status = document.querySelector<HTMLElement>('[role=status]')!;
const notice = document.querySelector<HTMLElement>('#notifications')!;
const error = document.querySelector<HTMLElement>('[role=alert]')!;
const lifetime = new AbortController();
let event: RallarRoomEvent | undefined;
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
    const { key, lobby, invitationSecret } = await openPickupInvitation(lifetime.signal);
    const alerts = await preparePickupAlerts(notice, lifetime.signal);

    async function joinEvent(): Promise<void> {
        const access = await joinPickupLobby({ lobby, key, invitationSecret, signal: lifetime.signal });
        const resource = new RallarRoomEvent(rallar, lobby);
        event = resource;
        join.hidden = true;
        let inCourt = false;
        const clicked = followPickupAlert({ lobby, event: resource, signal: lifetime.signal, reportError: message => { error.textContent = message; } });
        function render(): void {
            const { view, busy: working, error: failure, retryPending } = resource.getState();
            retry.hidden = !retryPending;
            retry.disabled = working;
            if (failure) error.textContent = failure;
            if (!view || view.closed) {
                queue.hidden = leave.hidden = enter.hidden = notify.hidden = disable.hidden = true;
                status.textContent = view?.closed ? 'Event closed.' : 'Recovering your event…';
                return;
            }
            const offered = view.offer;
            const alertStatus = courtAlertStatus(clicked.current(), view, rallar.deadlineAfter(0));
            status.textContent = pickupStatus(view, alertStatus === 'expired');
            queue.hidden = !!offered || !!view.queue;
            leave.hidden = !view.queue;
            enter.hidden = !offered || (inCourt && offered.deadline === null);
            enter.textContent = offered ? 'Enter ' + offered.groupId : 'Enter court';
            notify.hidden = !alerts;
            disable.hidden = !alerts || Notification.permission !== 'granted';
            for (const control of [queue, leave, enter, notify, disable]) control.disabled = working || retryPending;
        }
        resource.onChange(render);
        await resource.start();
        await clicked.refresh();
        render();
        if (alerts) showInstalledAlertSupport(notice, lifetime.signal);
        bind(retry, () => resource.retry());
        bind(queue, async () => {
            await resource.act({ action:'propose', partyId:crypto.randomUUID(), players:[access.clientId] });
            inCourt = false;
            await clicked.dismiss(); render();
        });
        bind(leave, () => resource.act({action:'leave-queue'}));
        bind(enter, async () => { await resource.enterCourt(); await clicked.dismiss(); render(); inCourt = true; enter.hidden = true; });
        bind(notify, async () => {
            const result = await enableCourtReadyNotifications(resource, alerts!.registration.pushManager, alerts!.publicKey);
            notice.textContent = result === 'enabled' ? 'Court alerts are on for this event.' : 'Permission was declined. You can still join the queue.';
            disable.hidden = result !== 'enabled';
        });
        bind(disable, async () => {
            await disableCourtReadyNotifications(resource, alerts!.registration.pushManager);
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
