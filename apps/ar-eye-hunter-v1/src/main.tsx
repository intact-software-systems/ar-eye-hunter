import { Temporal } from '@js-temporal/polyfill';
import React from 'react';
import { createRoot } from 'react-dom/client';

import '@shared/mod.ts';
import '@shared-graph/mod.ts';
import '@shared-web/mod.ts';

import { rallar } from '@shared-web/browser/rallar.ts';
import App from './App.tsx';
import './styles.css';

(globalThis as { Temporal?: typeof Temporal }).Temporal ??= Temporal;

const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
rallar.configure({
    apiBaseUrl: env['VITE_RALLAR_API_BASE_URL'] ?? env['VITE_API_BASE_URL'] ?? '',
});

const root = document.getElementById('root');
if (!root) {
    throw new Error('Missing root element.');
}

createRoot(root).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
