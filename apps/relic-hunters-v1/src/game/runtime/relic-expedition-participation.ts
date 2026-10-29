import {
    hasUnfinishedRelicParticipation,
    isRelicCommand,
    RELIC_PROTOCOL_VERSION,
    type RelicCommand,
    type RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import { hasRelicRematchParticipation } from '@relic-hunters/src/relic-rematch.ts';
import type { RallarDataFacade } from '@shared-web/browser/rallar-data.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { BoundedConcurrencyAdmission } from '@shared/resilience/bounded-concurrency-admission.ts';

import { RelicCommandRefusedError, type RelicCommandRequest } from '../api.ts';

interface PendingAdmission {
    readonly requestId: string;
    readonly command: RelicCommand;
}

interface AdmissionRecord {
    readonly pending: PendingAdmission | null;
}

export namespace RelicExpeditionParticipation {
    export interface Withdrawal {
        readonly roomId: string;
        readonly session: AuthSession;
    }
    export interface Dependencies {
        withParticipationLock<T>(roomId: string, sessionId: string, run: () => Promise<T>): Promise<T>;
        readonly data: Pick<RallarDataFacade, 'open'>;
        fetchSnapshot(roomId: string): Promise<RelicPublicSnapshot | undefined>;
        sendRestCommand(request: RelicCommandRequest): Promise<RelicPublicSnapshot | undefined>;
    }
}

/** Owns durable expedition admission and withdrawal; uncertain admission is reconciled before departure. */
export class RelicExpeditionParticipation {
    private readonly dependencies: RelicExpeditionParticipation.Dependencies;
    private readonly pending = new Map<string, boolean>();
    private readonly operations = new BoundedConcurrencyAdmission({ maxConcurrent: 1 });

    constructor(dependencies: RelicExpeditionParticipation.Dependencies) {
        this.dependencies = dependencies;
    }

    hasPending(roomId: string | undefined, sessionId: string | undefined): boolean {
        return !!roomId && !!sessionId && this.pending.get(JSON.stringify([roomId, sessionId])) !== false;
    }

    join(roomId: string, sessionId: string, command: RelicCommand): Promise<RelicPublicSnapshot | undefined> {
        return this.dependencies.withParticipationLock(
            roomId,
            sessionId,
            () => this.operations.admit(() => this.execute(roomId, sessionId, command))
        );
    }

    async reconcile(roomId: string, sessionId: string): Promise<RelicPublicSnapshot | undefined> {
        try {
            return await this.operations.admit(() => this.execute(roomId, sessionId, undefined));
        }
        catch (error) {
            if (error instanceof RelicCommandRefusedError) {
                return undefined;
            }
            throw error;
        }
    }

    /** Called while the room/session participation lock is held, before room membership may be removed. */
    async withdraw(
        { roomId, session }: RelicExpeditionParticipation.Withdrawal,
        isCurrent: () => boolean
    ): Promise<RelicPublicSnapshot | undefined> {
        await this.reconcile(roomId, session.sessionId);
        if (!isCurrent()) {
            return undefined;
        }
        const latest = await this.dependencies.fetchSnapshot(roomId);
        if (
            !isCurrent() ||
            !(hasUnfinishedRelicParticipation(latest, session.sessionId) ||
                hasRelicRematchParticipation(latest, session.sessionId))
        ) {
            return latest;
        }
        const snapshot = await this.dependencies.sendRestCommand({
            gameId: roomId,
            sessionId: session.sessionId,
            requestId: crypto.randomUUID(),
            command: {
                protocolVersion: RELIC_PROTOCOL_VERSION,
                gameId: roomId,
                username: session.username,
                kind: 'leave-expedition'
            }
        });
        if (
            !snapshot ||
            hasUnfinishedRelicParticipation(snapshot, session.sessionId) ||
            hasRelicRematchParticipation(snapshot, session.sessionId)
        ) {
            throw new Error('Withdrawal has not been confirmed. Stay in the room and try again.');
        }
        return snapshot;
    }

    private async execute(
        roomId: string,
        sessionId: string,
        command: RelicCommand | undefined
    ): Promise<RelicPublicSnapshot | undefined> {
        const key = JSON.stringify([roomId, sessionId]);
        const store = await this.dependencies.data.open<AdmissionRecord>('relic-expedition-admission', {
            scope: `session:${sessionId}`,
            durability: 'write-through',
            hydrate: 'lazy',
            sync: true
        });
        try {
            const previous = decodeAdmissionRecord(await store.get(roomId), roomId);
            const proposed: AdmissionRecord = { pending: command ? { requestId: crypto.randomUUID(), command } : null };
            const record = previous?.pending ? previous : proposed;
            this.pending.set(key, record.pending !== null);
            if (!record.pending) {
                return undefined;
            }
            if (record !== previous && !await store.compareAndSet(roomId, previous, record)) {
                throw new Error('Admission changed in another tab. Retry Join or Leave to reconcile it.');
            }
            let snapshot: RelicPublicSnapshot | undefined;
            let refusal: RelicCommandRefusedError | undefined;
            try {
                snapshot = await this.dependencies.sendRestCommand({
                    gameId: roomId,
                    command: record.pending.command,
                    requestId: record.pending.requestId,
                    sessionId
                });
            }
            catch (error) {
                if (!(error instanceof RelicCommandRefusedError)) {
                    throw error;
                }
                refusal = error;
            }
            if (!snapshot && !refusal) {
                throw new Error('Admission is unconfirmed. Retry Join or Leave to reconcile the original request.');
            }
            if (!await store.compareAndSet(roomId, record, { pending: null })) {
                throw new Error('Admission changed in another tab. Retry Join or Leave to reconcile it.');
            }
            this.pending.set(key, false);
            if (refusal) {
                throw refusal;
            }
            return snapshot;
        }
        finally {
            await store.close();
        }
    }
}

function decodeAdmissionRecord(value: unknown, roomId: string): AdmissionRecord | undefined {
    if (value === undefined || isAdmissionRecord(value, roomId)) {
        return value;
    }
    throw new TypeError('Invalid saved expedition admission');
}

function isAdmissionRecord(value: unknown, roomId: string): value is AdmissionRecord {
    if (typeof value !== 'object' || value === null || !('pending' in value)) {
        return false;
    }
    const pending = value.pending;
    return pending === null || typeof pending === 'object' && 'requestId' in pending &&
            typeof pending.requestId === 'string' && pending.requestId.length > 0 &&
            'command' in pending && isRelicCommand(pending.command) &&
            pending.command.kind === 'join-expedition' && pending.command.gameId === roomId;
}
