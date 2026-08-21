import { Temporal } from '@js-temporal/polyfill';
import { rallar } from '@shared-web/browser/rallar.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles.css';

(globalThis as any).Temporal = (globalThis as any).Temporal ?? Temporal;

const env = (import.meta as {
    env?: Record<string, string | boolean | undefined>;
}).env ?? {};

rallar.configure({
    apiBaseUrl: resolveApiBaseUrl(env['API_BASE_URL'], env.DEV === true)
});

createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
        <App />
    </StrictMode>
);

function resolveApiBaseUrl(
    configured: string | boolean | undefined,
    isDev: boolean
): string {
    const value = typeof configured === 'string' ? configured.trim() : '';
    if (!value) {
        return '';
    }

    if (!isDev) {
        return value;
    }

    try {
        const configuredUrl = new URL(value);
        const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
        if (
            localHosts.has(configuredUrl.hostname) &&
            localHosts.has(window.location.hostname) &&
            configuredUrl.port !== window.location.port
        ) {
            return '';
        }
    }
    catch {
        return value;
    }

    return value;
}
