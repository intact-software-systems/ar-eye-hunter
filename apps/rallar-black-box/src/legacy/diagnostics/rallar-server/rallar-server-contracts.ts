import type { RallarServerRestMethod } from '../../../rallar-server-workbench.ts';

export type RallarServerRequestFeedback = Readonly<{
    state: 'idle' | 'sending' | 'success' | 'error';
    method?: RallarServerRestMethod;
    path?: string;
    url?: string;
    status?: number;
    statusText?: string;
    durationMs?: number;
    errorKind?: string;
    message?: string;
    atEpochMs?: number;
}>;
