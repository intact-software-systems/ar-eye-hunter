import type { AuthSession } from '@shared/api/api-config.ts';
import type { ViewWatchRequest, ViewWatchResult } from '@shared/api/views/view-watch.ts';
import { ExclusionKeyedAdmission } from '@shared/resilience/exclusion-keyed-admission.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { TryWithPolicy } from '@shared/resilience/try-with-policy.ts';
import { toAuthSessionKey } from '../auth/to-auth-session-key.ts';
import { isDefinitiveApiMutationFailure } from './is-definitive-api-mutation-failure.ts';

export namespace SelectedViewWatch {
    export interface Selection {
        readonly session: AuthSession;
        readonly resourceId: string | null;
        readonly connectionGenerationId: string;
        readonly signal: AbortSignal;
    }
    export interface ChangeInput {
        readonly session: AuthSession;
        readonly requestId: string;
        readonly request: ViewWatchRequest;
        readonly signal: AbortSignal;
    }
    export interface Dependencies {
        change(input: ChangeInput): Promise<ViewWatchResult>;
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
    resourceId: string | null;
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
                resourceId: null,
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
            await this.replayPending(registration, signal);
            if (registration.ownedRegistrationId === null) {
                return;
            }
            const input = this.createChange(
                { ...registration, registrationId: registration.ownedRegistrationId },
                null,
                signal
            );
            this.assertCommandResult(input, await this.dependencies.change(input));
        });
    }

    /** An unresolved replay must not keep the earlier owned registration alive; its clear still runs. */
    private async replayPending(registration: WatchRegistration, signal: AbortSignal): Promise<void> {
        if (registration.pending === null) {
            return;
        }
        const pending = { ...registration.pending, signal };
        registration.pending = null;
        try {
            const result = await this.dependencies.change(pending);
            this.assertCommandResult(pending, result);
            if (result.status === 'applied') {
                registration.ownedRegistrationId = result.registrationId;
            }
        }
        catch (error) {
            console.warn('Selected preview registration replay failed before cleanup', toError(error));
        }
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
                    registration.settled && registration.pending === null &&
                    registration.resourceId === selection.resourceId
                ) {
                    return;
                }
                const pending = registration.pending?.request.resourceId === selection.resourceId
                    ? { ...registration.pending, signal: selection.signal }
                    : this.createChange(registration, selection.resourceId, selection.signal);
                registration.pending = pending;
                const result = await this.writePending(registration, pending);
                registration.registrationId = result.registrationId;
                registration.resourceId = result.resourceId;
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

    /** A definitive refusal ends the command identity; only an unresolved outcome keeps it for replay. */
    private async writePending(
        registration: WatchRegistration,
        pending: SelectedViewWatch.ChangeInput
    ): Promise<ViewWatchResult> {
        try {
            const result = await this.dependencies.change(pending);
            this.assertCommandResult(pending, result);
            return result;
        }
        catch (error) {
            if (registration.pending === pending && isDefinitiveApiMutationFailure(toError(error))) {
                registration.pending = null;
            }
            throw error;
        }
    }

    private createChange(
        registration: WatchRegistration,
        resourceId: string | null,
        signal: AbortSignal
    ): SelectedViewWatch.ChangeInput {
        return {
            session: registration.session,
            requestId: this.dependencies.createId(),
            signal,
            request: {
                resourceId,
                connectionGenerationId: registration.connectionGenerationId,
                expectedRegistrationId: registration.registrationId
            }
        };
    }

    private assertCommandResult(input: SelectedViewWatch.ChangeInput, result: ViewWatchResult): void {
        if (
            result.requestId !== input.requestId ||
            (result.status === 'applied' && (result.resourceId !== input.request.resourceId ||
                result.registrationId !== (input.request.resourceId === null ? null : input.requestId)))
        ) {
            throw new TypeError('Preview registration result belongs to another command');
        }
    }
}
