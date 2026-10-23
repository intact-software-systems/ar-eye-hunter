import { Temporal } from '@js-temporal/polyfill';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { rallar } from '@shared-web/browser/rallar.ts';

import App from './app.tsx';
import './styles.css';

if (!('Temporal' in globalThis)) {
    Object.defineProperty(globalThis, 'Temporal', { value: Temporal, configurable: true });
}

rallar.configure({
    apiBaseUrl: resolveApiBaseUrl(import.meta.env.API_BASE_URL, import.meta.env.DEV, window.location)
});

const root = document.getElementById('root');
if (!root) {
    throw new Error('The Relic Hunters page is missing its root element.');
}
createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>
);

function resolveApiBaseUrl(
    configured: string | boolean | undefined,
    isDev: boolean,
    location: Location
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
            localHosts.has(location.hostname) &&
            configuredUrl.port !== location.port
        ) {
            return '';
        }
    }
    catch {
        return value;
    }

    return value;
}
