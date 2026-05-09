import { Temporal } from '@js-temporal/polyfill';
(globalThis as any).Temporal = (globalThis as any).Temporal ?? Temporal;

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { rallar } from '@shared-web/browser/rallar.ts';
import App from './App.tsx';
import './styles.css';

const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
rallar.configure({
    apiBaseUrl: env['VITE_RALLAR_API_BASE_URL'] ?? env['API_BASE_URL'] ?? '',
});

createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
        <App/>
    </StrictMode>,
);
