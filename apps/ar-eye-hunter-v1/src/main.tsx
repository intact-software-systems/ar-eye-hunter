import { Temporal } from '@js-temporal/polyfill';
import React from 'react';
import { createRoot } from 'react-dom/client';

import { configureAuthSessionStorage } from '@shared/api/auth.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import App from './App.tsx';
import { GAME_COMBAT_LANE_ID } from './game/types.ts';
import './styles.css';

(globalThis as any).Temporal = (globalThis as any).Temporal ?? Temporal;

(globalThis as { Temporal?: typeof Temporal }).Temporal ??= Temporal;

const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const url = env['API_BASE_URL'];
if (url === undefined) {
    throw new Error('Missing API_BASE_URL');
}

const authStorage = env['VITE_RALLAR_AUTH_STORAGE'] ?? 'session';
if (authStorage === 'session' || authStorage === 'local') {
    configureAuthSessionStorage(authStorage);
}

rallar.configure({
    apiBaseUrl: url,
});
rallar.setDefaults({
    applicationId: 'ar-eye-hunter',
    workspaceId: 'default',
    realtime: {
        laneId: GAME_COMBAT_LANE_ID,
        openTimeoutMs: 1000,
    },
    rtc: {
        waitTimeoutMs: 1000,
        connectOnWait: true,
    },
});

const root = document.getElementById('root');
if (!root) {
    throw new Error('Missing root element.');
}

createRoot(root).render(
    <React.StrictMode>
        <App/>
    </React.StrictMode>,
);
