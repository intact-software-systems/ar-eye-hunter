import { Temporal } from '@js-temporal/polyfill';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { rallar } from '@shared-web/browser/rallar.ts';
import App from './App.tsx';
import './styles.css';

(globalThis as any).Temporal = (globalThis as any).Temporal ?? Temporal;

const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

const url = env['API_BASE_URL'];
if (url === undefined) {
    throw new Error('Missing API_BASE_URL');
}

rallar.configure({
    apiBaseUrl: url,
});

createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
        <App/>
    </StrictMode>,
);
