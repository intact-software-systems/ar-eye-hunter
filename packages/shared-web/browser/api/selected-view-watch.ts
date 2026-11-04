import type { AuthSession } from '@shared/api/api-config.ts';
import type { SessionPreviewWatchRequest, SessionPreviewWatchResult } from '@shared/api/views/view-watch.ts';
import { ExclusionKeyedAdmission } from '@shared/resilience/exclusion-keyed-admission.ts';
import { TryWithPolicy } from '@shared/resilience/try-with-policy.ts';
import { toAuthSessionKey } from '../auth/to-auth-session-key.ts';

export namespace SelectedViewWatch {
    export interface Selection {
        readonly session: AuthSession;
        readonly groupId: string | null;
        readonly connectionGenerationId: string;
        readonly signal: AbortSignal;
    }
    export interface ChangeInput {
        readonly session: AuthSession;
        readonly requestId: string;
        readonly request: SessionPreviewWatchRequest;
        readonly signal: AbortSignal;
    }
    export interface Dependencies {
        change(input: ChangeInput): Promise<SessionPreviewWatchResult>;
        createId(): string;
    }
}

interface WatchRegistration {
    readonly key: string;
    readonly session: AuthSession;
    readonly connectionGenerationId: string;
    settled: boolean;
    /** The observed predecessor may belong to another owner; only applied own tokens may be cleaned up. */
    registrationId: string | null;
    ownedRegistrationId: string | null;
    groupId: string | null;
    pending: SelectedViewWatch.ChangeInput | null;
}

class WatchRegistrationConflict extends Error {}

/** Owns the browser's selected preview interest; canonical reads begin only after its registration commits. */
export class SelectedViewWatch {
    private readonly dependencies: SelectedViewWatch.Dependencies;
    private readonly calls = new ExclusionKeyedAdmission({
        maxConcurrent: Number.MAX_SAFE_INTEGER,
        keyedChainsFirst: false
    });
    private registration: WatchRegistration | null = null;

    constructor(dependencies: SelectedViewWatch.Dependencies) {
        this.dependencies = dependencies;
    }

    select(input: SelectedViewWatch.Selection): Promise<void> {
        input.signal.throwIfAborted();
        const key = JSON.stringify([toAuthSessionKey(input.session), input.connectionGenerationId]);
        if (this.registration?.key !== key) {
            this.registration = {
                key,
                session: input.session,
                connectionGenerationId: input.connectionGenerationId,
                settled: false,
                registrationId: null,
                ownedRegistrationId: null,
                groupId: null,
                pending: null
            };
        }
        const registration = this.registration;
        return this.calls.admit(key, () => this.reconcile(registration, input));
    }

    /** Cleanup uses its captured predecessor once; a conflict belongs to the newer selection. */
    release(): Promise<void> {
        const registration = this.registration;
        this.registration = null;
        if (registration === null) {
            return Promise.resolve();
        }
        return this.calls.admit(registration.key, async () => {
            const signal = AbortSignal.timeout(10_000);
            if (registration.pending !== null) {
                const pending = { ...registration.pending, signal };
                const result = await this.dependencies.change(pending);
                this.validateResult(pending, result);
                if (result.status === 'applied') {
                    registration.ownedRegistrationId = result.registrationId;
                }
            }
            if (registration.ownedRegistrationId === null) {
                return;
            }
            const input = this.createChange(
                { ...registration, registrationId: registration.ownedRegistrationId },
                null,
                signal
            );
            this.validateResult(input, await this.dependencies.change(input));
        });
    }

    private async reconcile(registration: WatchRegistration, selection: SelectedViewWatch.Selection): Promise<void> {
        await TryWithPolicy.defaults().label('selected preview registration')
            .maxAttempts(3).retryIntervalMsecs(50).maxRetryIntervalMsecs(250)
            .retryIf((error) => error instanceof WatchRegistrationConflict && !selection.signal.aborted)
            .run(async () => {
                selection.signal.throwIfAborted();
                if (this.registration !== registration) {
                    return;
                }
                if (
                    registration.settled && registration.pending === null && registration.groupId === selection.groupId
                ) {
                    return;
                }
                const pending = registration.pending?.request.groupId === selection.groupId
                    ? { ...registration.pending, signal: selection.signal }
                    : this.createChange(registration, selection.groupId, selection.signal);
                registration.pending = pending;
                const result = await this.dependencies.change(pending);
                this.validateResult(pending, result);
                registration.registrationId = result.registrationId;
                registration.groupId = result.groupId;
                registration.pending = null;
                registration.settled = result.status === 'applied';
                if (result.status === 'applied') {
                    registration.ownedRegistrationId = result.registrationId;
                }
                if (result.status === 'conflict') {
                    throw new WatchRegistrationConflict('Preview selection changed before registration');
                }
            });
    }

    private createChange(
        registration: WatchRegistration,
        groupId: string | null,
        signal: AbortSignal
    ): SelectedViewWatch.ChangeInput {
        return {
            session: registration.session,
            requestId: this.dependencies.createId(),
            signal,
            request: {
                groupId,
                connectionGenerationId: registration.connectionGenerationId,
                expectedRegistrationId: registration.registrationId
            }
        };
    }

    private validateResult(input: SelectedViewWatch.ChangeInput, result: SessionPreviewWatchResult): void {
        if (
            result.requestId !== input.requestId ||
            (result.status === 'applied' && (result.groupId !== input.request.groupId ||
                result.registrationId !== (input.request.groupId === null ? null : input.requestId)))
        ) {
            throw new TypeError('Preview registration result belongs to another command');
        }
    }
}
