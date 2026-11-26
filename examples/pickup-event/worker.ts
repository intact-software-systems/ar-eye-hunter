import { courtAlertLaunchUrl, courtReadyNotification } from '@shared-web/browser/rooms/events/court-alert-notification.ts';

const worker = self as unknown as ServiceWorkerGlobalScope;
worker.addEventListener('push', event => {
    const notice = courtReadyNotification(event.data?.json());
    event.waitUntil(worker.registration.showNotification(notice.title, notice.options));
});
worker.addEventListener('notificationclick', event => {
    const url = courtAlertLaunchUrl(worker.registration.scope, event.notification.data);
    event.notification.close();
    event.waitUntil(worker.clients.openWindow(url.href));
});
