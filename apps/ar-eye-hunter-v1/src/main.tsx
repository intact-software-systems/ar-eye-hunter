import { Temporal } from '@js-temporal/polyfill';
import React from 'react';
import { createRoot } from 'react-dom/client';

import '@shared/mod.ts';
import '@shared-graph/mod.ts';
import '@shared-web/mod.ts';

import { rallar } from '@shared-web/browser/rallar.ts';
import App from './App.tsx';
import './styles.css';

(globalThis as any).Temporal = (globalThis as any).Temporal ?? Temporal;

(globalThis as { Temporal?: typeof Temporal }).Temporal ??= Temporal;

const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const url = env['API_BASE_URL'];
if (url === undefined) {
    throw new Error('Missing API_BASE_URL');
}

rallar.configure({
    apiBaseUrl: url,
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
