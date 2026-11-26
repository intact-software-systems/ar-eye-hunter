import { readCourtAlertPublicKey } from '@shared-web/browser/rooms/events/court-ready-notifications.ts';

export async function preparePickupAlerts(notice: HTMLElement, signal: AbortSignal) {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios && !matchMedia('(display-mode: standalone)').matches) {
        notice.textContent = 'For alerts on a future visit, add this app to your Home Screen and open it there before joining.';
        return null;
    }
    if (!('PushManager' in window && 'serviceWorker' in navigator && 'Notification' in window)) return null;
    try {
        const publicKey = await readCourtAlertPublicKey(signal);
        if (!publicKey) return null;
        const installed = await navigator.serviceWorker.register('./worker.js', { type: 'module', scope: './', updateViaCache: 'none' });
        await installed.update();
        const registration = await navigator.serviceWorker.ready;
        return { publicKey, registration };
    } catch {
        notice.textContent = 'Alerts are unavailable in this browser. You can still join the queue.';
        return null;
    }
}

/** Listen for the running worker so an install upgrade can be verified on an already enrolled phone. */
export function showInstalledAlertSupport(notice: HTMLElement, signal: AbortSignal): void {
    if (!('serviceWorker' in navigator)) return;
    const check = () => {
        const controller = navigator.serviceWorker.controller;
        if (!controller) return;
        const channel = new MessageChannel();
        const timeout = setTimeout(() => channel.port1.close(), 5000);
        channel.port1.onmessage = reply => {
            clearTimeout(timeout);
            channel.port1.close();
            if (!signal.aborted && reply.data === 'pickup:can-open-alert') {
                notice.textContent = 'This device is ready to open court alerts.';
            }
        };
        controller.postMessage('pickup:check-alert-support', [channel.port2]);
    };
    navigator.serviceWorker.addEventListener('controllerchange', check, { signal });
    check();
}
