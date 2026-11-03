import type { TournamentMatchBinding } from './tournament-types.ts';

/** Validated domain command. Schedule identities are materialized by the server, never accepted from an HTTP body. */
export type TournamentCommand =
    | { readonly type: 'register' | 'withdraw' | 'launch' | 'cancel' | 'reconcile'; }
    | {
        readonly type: 'check-in' | 'start';
        readonly slot: TournamentMatchBinding['slot'];
        readonly attemptId: string;
    }
    | {
        readonly type: 'schedule';
        readonly slot: TournamentMatchBinding['slot'];
        readonly attemptId: string;
        readonly roomId: string;
        readonly gameId: string;
        readonly scheduledAtEpochMs: number;
    };
