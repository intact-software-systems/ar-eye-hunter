import { openCourtAlertClick } from '@shared-web/browser/rooms/events/court-alert-click.ts';
import { courtReadyNotification } from '@shared-web/browser/rooms/events/court-alert-notification.ts';

declare const self: ServiceWorkerGlobalScope;
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
    if (event.data === 'pickup:check-alert-support') event.ports[0]?.postMessage('pickup:can-open-alert');
});
self.addEventListener('push', event => {
    const notice = courtReadyNotification(event.data?.json());
    event.waitUntil(self.registration.showNotification(notice.title, notice.options));
});
self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(openCourtAlertClick({
        scope: self.registration.scope,
        storage: self.caches,
        message: event.notification.data,
        windows: () => self.clients.matchAll({ type: 'window', includeUncontrolled: true }),
        openWindow: url => self.clients.openWindow(url)
    }));
});
