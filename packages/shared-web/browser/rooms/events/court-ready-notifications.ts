import { isApiJsonObject, type ApiJsonValue } from '@shared/api/api-json-value.ts';
import { decodeEventPushSubscription } from '@shared/api/room-events/room-event-alerts.ts';
import { decodeBase64Url } from '@shared/encoding/base64url.ts';
import { readApiBaseUrl } from '../../api-client-config.ts';
import { sendApiHttpRequest } from '../../api/send-api-http-request.ts';
import type { RallarRoomEvent } from './rallar-room-event.ts';

interface CourtPushManager {
    getSubscription(): Promise<Pick<PushSubscription, 'endpoint' | 'toJSON'> | null>;
    subscribe(options: PushSubscriptionOptionsInit): Promise<Pick<PushSubscription, 'endpoint' | 'toJSON'>>;
}

/** Read at startup so a user gesture can request OS permission immediately. */
export async function readCourtAlertPublicKey(signal?: AbortSignal): Promise<string | null> {
    const value = await sendApiHttpRequest<undefined, ApiJsonValue>({ baseUrl: readApiBaseUrl(), path: '/api/room-event-alerts/public-key',
        method: 'GET', body: undefined, options: { authSession: null, signal } });
    if (!isApiJsonObject(value) || !(value.publicKey === null || typeof value.publicKey === 'string' &&
        decodeBase64Url(value.publicKey).right?.byteLength === 65)) throw new TypeError('Invalid court alert configuration.');
    return value.publicKey;
}

function readyPrincipal(event: Pick<RallarRoomEvent, 'getState'>): string {
    const { view, busy, retryPending } = event.getState();
    if (!view || view.closed || busy || retryPending) throw new Error('The event is unavailable or busy.');
    return view.principalId;
}

async function changeConsent(event: Pick<RallarRoomEvent, 'act' | 'getState'>, principal: string, command: RallarRoomEvent.Action): Promise<void> {
    if (readyPrincipal(event) !== principal) throw new Error('The event player changed.');
    await event.act(command);
    const state = event.getState();
    if (state.view?.principalId !== principal || state.error || state.retryPending) throw new Error(state.error ?? 'Court alert consent was not confirmed.');
}

/** Invoke directly from a tap in the installed app. Permission denial leaves queue eligibility intact. */
export async function enableCourtReadyNotifications(event: Pick<RallarRoomEvent, 'act' | 'getState'>,
    manager: CourtPushManager, applicationServerKey: string): Promise<'enabled' | 'denied'> {
    const principal = readyPrincipal(event);
    const key = decodeBase64Url(applicationServerKey).right;
    if (key?.byteLength !== 65) throw new TypeError('Invalid Web Push public key.');
    if (await Notification.requestPermission() !== 'granted') return 'denied';
    const device = await manager.getSubscription() ?? await manager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(key) });
    const subscription = decodeEventPushSubscription({ endpoint: device.endpoint, ...device.toJSON().keys });
    await changeConsent(event, principal, { action: 'enable-court-alerts', subscription });
    return 'enabled';
}

/** Other events can use the same origin's PushSubscription. Only withdraw this event's consent. */
export async function disableCourtReadyNotifications(event: Pick<RallarRoomEvent, 'act' | 'getState'>,
    manager: Pick<CourtPushManager, 'getSubscription'>): Promise<void> {
    const principal = readyPrincipal(event);
    const device = await manager.getSubscription();
    if (device) await changeConsent(event, principal, { action: 'disable-court-alerts', endpoint: device.endpoint });
}
