import type { TournamentSnapshot } from '@shared/api/tournaments/tournament-snapshot.ts';
import type { TournamentRef } from '@shared/api/tournaments/tournament-types.ts';
import type { TournamentRepository } from './tournament-repository.ts';

export namespace TournamentReader {
    export interface Account {
        readonly ref: TournamentRef;
        readonly principalId: string;
    }
}

/** Public bracket projection never serializes captured check-in sessions or private game authority. */
export class TournamentReader {
    private readonly repository: Pick<TournamentRepository, 'readRecord'>;
    private readonly nowEpochMs: () => number;

    constructor(repository: Pick<TournamentRepository, 'readRecord'>, nowEpochMs: () => number) {
        this.repository = repository;
        this.nowEpochMs = nowEpochMs;
    }

    async read(account: TournamentReader.Account): Promise<TournamentSnapshot> {
        const read = await this.repository.readRecord(account.ref);
        return {
            ref: read.ref,
            principalId: account.principalId,
            observedAtEpochMs: this.nowEpochMs(),
            tournament: read.record?.tournament ?? null
        };
    }
}
