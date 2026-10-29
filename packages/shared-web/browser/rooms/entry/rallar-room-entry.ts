import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { Either, Try } from '@shared/resilience/Either.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { ApiHttpError } from '../../api/http-error.ts';
import { toAuthSessionKey } from '../../auth/to-auth-session-key.ts';
import type { RallarStateListener, RallarUnsubscribe } from '../../rallar-shared-contracts.ts';
import type { RallarAuthFacade, RallarAuthState } from '../../session/rallar-auth-facade.ts';
import type { BrowserRallarRooms } from '../browser-rallar-rooms.ts';
import type { RallarJoinRoomOptions, RallarRoomState } from '../rallar-room-contracts.ts';
import type {
    GroupRef,
    GroupSnapshot,
    StateScope
} from '../room-group-state-translation.ts';
import {
    decodeRoomEntryDestination,
    decodeScopedDestination,
    invalidDestination
} from './room-entry-validation.ts';

const ENTRY_FRAGMENT = '#rallar-room?';
const ENTRY_FIELDS = new Set(['applicationId', 'workspaceId', 'groupId', 'joinCode', 'participation']);

export namespace RallarRoomEntry {
    export interface Destination {
        readonly roomRef: GroupRef;
        readonly joinCode: string | null;
        readonly participation: 'player' | 'spectator' | 'preserve';
    }

    export interface Failure {
        readonly kind: 'invalid-destination' | 'storage' | 'denied' | 'transport' | 'partial' | 'account-mismatch';
        readonly message: string;
        readonly admittedRoom: GroupRef | null;
    }

    export interface State {
        readonly status: 'idle' | 'pending' | 'joining' | 'entered' | 'failed';
        readonly destination: Destination | null;
        readonly principalId: string | null;
        readonly failure: Failure | null;
    }

    export interface Auth extends Pick<RallarAuthFacade, 'onChange'> {
        session(): AuthSession | undefined;
    }

    export interface Rooms extends Pick<BrowserRallarRooms, 'onChange'> {
        join(roomRef: GroupRef, options: RallarJoinRoomOptions): Promise<GroupSnapshot>;
    }

    export interface Location {
        read(): string;
        replace(url: string): void;
        onChange(listener: () => void): RallarUnsubscribe;
    }

    export interface Dependencies {
        readonly auth: Auth;
        readonly rooms: Rooms;
        readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
        readonly location: Location;
    }

    export interface Config {
        readonly scope: StateScope;
    }

    export interface Browser {
        readonly auth: Pick<RallarAuthFacade, 'onChange'>;
        readonly rooms: Rooms;
        session(): AuthSession | undefined;
    }

    export interface SavedEntry {
        readonly destination: Destination;
        readonly principalId: string | null;
    }

    export interface Attempt {
        readonly generation: number;
        readonly destination: Destination;
        readonly session: AuthSession;
        readonly controller: AbortController;
    }
}

export class RallarRoomEntry {
    private state: RallarRoomEntry.State = { status: 'idle', destination: null, principalId: null, failure: null };
    private readonly dependencies: RallarRoomEntry.Dependencies;
    private readonly config: RallarRoomEntry.Config;
    private readonly storageKey: string;
    private readonly notifications = new SynchronousNotifications<RallarRoomEntry.State>((error) => {
        console.error('Error notifying room entry listener', error);
    });
    private readonly flights = new SingleFlight<string, RallarRoomEntry.State>();
    private subscriptions: SubscriptionScope | null = null;
    private attempt: RallarRoomEntry.Attempt | null = null;
    private generation = 0;
    private sessionKey: string | null = null;

    public static createBrowser(
        rallar: RallarRoomEntry.Browser,
        config: RallarRoomEntry.Config
    ): RallarRoomEntry {
        return new RallarRoomEntry({
            auth: {
                session: () => rallar.session(),
                onChange: (listener, options) => rallar.auth.onChange(listener, options)
            },
            rooms: rallar.rooms,
            storage: {
                getItem: (key) => window.sessionStorage.getItem(key),
                setItem: (key, value) => window.sessionStorage.setItem(key, value),
                removeItem: (key) => window.sessionStorage.removeItem(key)
            },
            location: {
                read: () => window.location.href,
                replace: (url) => window.history.replaceState(window.history.state, '', url),
                onChange: (listener) => {
                    window.addEventListener('hashchange', listener);
                    window.addEventListener('popstate', listener);
                    return () => {
                        window.removeEventListener('hashchange', listener);
                        window.removeEventListener('popstate', listener);
                    };
                }
            }
        }, config);
    }

    public constructor(dependencies: RallarRoomEntry.Dependencies, config: RallarRoomEntry.Config) {
        this.dependencies = dependencies;
        this.config = config;
        this.storageKey = `rallar.room-entry:${JSON.stringify([config.scope.applicationId, config.scope.workspaceId])}`;
    }

    public getState(): RallarRoomEntry.State {
        return this.state;
    }

    /** Capture the destination before startup; resume only after authenticated startup completes. */
    public start(): RallarRoomEntry.State {
        if (this.subscriptions) {
            return this.state;
        }
        const session = this.dependencies.auth.session();
        this.sessionKey = session ? toAuthSessionKey(session) : null;
        this.subscriptions = new SubscriptionScope();
        this.subscriptions.add(
            this.dependencies.auth.onChange((state) => this.authChanged(state), { emitCurrent: false })
        );
        this.subscriptions.add(
            this.dependencies.rooms.onChange((state) => this.roomChanged(state), { emitCurrent: false })
        );
        this.subscriptions.add(this.dependencies.location.onChange(() => this.locationChanged()));
        return this.captureDestination();
    }

    public enter(destination: RallarRoomEntry.Destination): RallarRoomEntry.State {
        this.invalidateAttempt();
        const decoded = decodeScopedDestination(destination, this.config.scope);
        if (decoded.left) {
            const failed: RallarRoomEntry.State = {
                status: 'failed',
                destination: null,
                principalId: null,
                failure: decoded.left
            };
            return this.publish(this.saveDestination(failed));
        }
        return this.publish(this.saveDestination({
            status: 'pending',
            destination: decoded.right ?? null,
            principalId: null,
            failure: null
        }));
    }

    /** Select a recent room for its account without treating local history as admission. */
    public returnTo(roomRef: GroupRef, principalId: string): Either<RallarRoomEntry.Failure, RallarRoomEntry.State> {
        if (!principalId || this.dependencies.auth.session()?.clientId !== principalId) {
            return Either.ofLeft({
                kind: 'account-mismatch',
                message: 'Sign in with the account that visited this room.',
                admittedRoom: null
            });
        }
        return decodeScopedDestination({ roomRef, joinCode: null, participation: 'preserve' }, this.config.scope)
            .mapRight((destination) => {
                this.invalidateAttempt();
                return this.publish(
                    this.saveDestination({ status: 'pending', destination, principalId, failure: null })
                );
            });
    }

    public resume(): Promise<RallarRoomEntry.State> {
        if (!this.subscriptions) {
            return Promise.resolve(this.state);
        }
        if (!this.state.destination && this.state.failure?.kind === 'storage') {
            this.captureDestination();
        }
        const destination = this.state.destination;
        const session = this.dependencies.auth.session();
        if (!destination || !session || this.state.status === 'entered') {
            return Promise.resolve(this.state);
        }
        if (this.state.principalId !== null && this.state.principalId !== session.clientId) {
            return Promise.resolve(this.publish({
                ...this.state,
                status: 'failed',
                failure: {
                    kind: 'account-mismatch',
                    message: 'Sign in with the account that joined this room, or open a new invitation.',
                    admittedRoom: null
                }
            }));
        }
        const saved = this.saveDestination({ ...this.state, failure: null });
        if (saved.failure?.kind === 'storage') {
            return Promise.resolve(this.publish(saved));
        }
        const generation = this.generation;
        return this.flights.run(
            `${generation}:${toAuthSessionKey(session)}`,
            () => this.joinDestination({ generation, destination, session, controller: new AbortController() })
        );
    }

    public cancel(): RallarRoomEntry.State {
        this.invalidateAttempt();
        return this.publish(
            this.saveDestination({ status: 'idle', destination: null, principalId: null, failure: null })
        );
    }

    public onChange(listener: RallarStateListener<RallarRoomEntry.State>): RallarUnsubscribe {
        return this.notifications.subscribeAndNotify(listener, this.state).unsubscribe;
    }

    public stop(): void {
        this.invalidateAttempt();
        const subscriptions = this.subscriptions;
        this.subscriptions = null;
        try {
            subscriptions?.unsubscribe();
        }
        finally {
            if (this.state.status === 'joining') {
                this.publish({ ...this.state, status: 'pending', failure: null });
            }
        }
    }

    private captureDestination(): RallarRoomEntry.State {
        const link = this.readLocationDestination();
        if (link.left) {
            return this.publish({ status: 'failed', destination: null, principalId: null, failure: link.left });
        }
        if (link.right) {
            return this.enter(link.right);
        }
        const saved = Try.compute(() => this.dependencies.storage.getItem(this.storageKey))
            .flatMap<RallarRoomEntry.Failure, RallarRoomEntry.SavedEntry | null>(
                () => Either.ofLeft(storageFailure(null)),
                (value) => value === null ? Either.ofRight(null) : decodeSavedEntry(value, this.config.scope)
            );
        if (saved.left) {
            return this.publish({ status: 'failed', destination: null, principalId: null, failure: saved.left });
        }
        return this.publish(
            saved.right
                ? { ...saved.right, status: 'pending', failure: null }
                : { status: 'idle', destination: null, principalId: null, failure: null }
        );
    }

    private async joinDestination(attempt: RallarRoomEntry.Attempt): Promise<RallarRoomEntry.State> {
        if (!this.isCurrent(attempt)) {
            return this.state;
        }
        this.attempt = attempt;
        this.publish({ ...this.state, status: 'joining', failure: null });
        if (!this.isCurrent(attempt)) {
            return this.state;
        }
        try {
            await this.dependencies.rooms.join(attempt.destination.roomRef, {
                joinCode: attempt.destination.joinCode ?? undefined,
                participation: attempt.destination.participation === 'preserve'
                    ? undefined
                    : attempt.destination.participation,
                signal: attempt.controller.signal
            });
            if (this.isCurrent(attempt)) {
                this.publish(this.saveDestination({
                    status: 'entered',
                    destination: { roomRef: attempt.destination.roomRef, joinCode: null, participation: 'preserve' },
                    principalId: attempt.session.clientId,
                    failure: null
                }));
            }
        }
        catch (error) {
            if (this.isCurrent(attempt)) {
                const failure = toEntryFailure(toError(error), attempt.destination);
                const failed: RallarRoomEntry.State = {
                    status: 'failed',
                    destination: failure.admittedRoom
                        ? { roomRef: failure.admittedRoom, joinCode: null, participation: 'preserve' }
                        : attempt.destination,
                    principalId: failure.admittedRoom ? attempt.session.clientId : this.state.principalId,
                    failure
                };
                this.publish(failure.admittedRoom ? this.saveDestination(failed) : failed);
            }
        }
        finally {
            if (this.attempt === attempt) {
                this.attempt = null;
            }
        }
        return this.state;
    }

    private isCurrent(attempt: RallarRoomEntry.Attempt): boolean {
        const session = this.dependencies.auth.session();
        return this.subscriptions !== null && this.generation === attempt.generation &&
            !attempt.controller.signal.aborted && session !== undefined &&
            toAuthSessionKey(session) === toAuthSessionKey(attempt.session);
    }

    private invalidateAttempt(): void {
        this.generation += 1;
        this.attempt?.controller.abort();
        this.attempt = null;
        this.flights.clear();
    }

    private authChanged(state: RallarAuthState): void {
        const key = state.session ? toAuthSessionKey(state.session) : null;
        if (key === this.sessionKey) {
            return;
        }
        this.sessionKey = key;
        this.invalidateAttempt();
        if (this.state.destination) {
            this.publish({ ...this.state, status: 'pending', failure: null });
        }
    }

    private roomChanged(state: RallarRoomState): void {
        const session = this.dependencies.auth.session();
        if (!session || (this.state.status !== 'idle' && this.state.status !== 'entered')) {
            return;
        }
        if (!state.currentRoomRef) {
            if (this.state.status === 'entered') {
                this.cancel();
            }
            return;
        }
        const destination = decodeScopedDestination(
            { roomRef: state.currentRoomRef, joinCode: null, participation: 'preserve' },
            this.config.scope
        ).right;
        if (!destination) {
            return;
        }
        if (this.state.destination && isSameGroupRef(this.state.destination.roomRef, state.currentRoomRef)) {
            return;
        }
        this.publish(this.saveDestination({
            status: 'entered',
            destination,
            principalId: session.clientId,
            failure: null
        }));
    }

    private readLocationDestination(): Either<RallarRoomEntry.Failure, RallarRoomEntry.Destination | null> {
        return Try.compute(() => this.dependencies.location.read()).flatMap<
            RallarRoomEntry.Failure,
            RallarRoomEntry.Destination | null
        >(
            () => Either.ofLeft(storageFailure(null)),
            (url) => readRoomEntryDestination(url, this.config.scope)
        );
    }

    private locationChanged(): void {
        const destination = this.readLocationDestination();
        if (destination.left) {
            this.invalidateAttempt();
            this.publish({ status: 'failed', destination: null, principalId: null, failure: destination.left });
        }
        else if (destination.right) {
            this.enter(destination.right);
        }
    }

    /** Persist before removing the URL credential, so failure never discards the only recoverable destination. */
    private saveDestination(state: RallarRoomEntry.State): RallarRoomEntry.State {
        const saved = Try.compute(() => {
            if (state.destination) {
                const entry: RallarRoomEntry.SavedEntry = {
                    destination: state.destination,
                    principalId: state.principalId
                };
                this.dependencies.storage.setItem(this.storageKey, JSON.stringify(entry));
            }
            else {
                this.dependencies.storage.removeItem(this.storageKey);
            }
            const url = new URL(this.dependencies.location.read());
            if (url.hash.startsWith('#rallar-room')) {
                url.hash = '';
                this.dependencies.location.replace(url.href);
            }
            return true;
        });
        return saved.left
            ? {
                ...state,
                status: 'failed',
                failure: storageFailure(state.principalId ? state.destination?.roomRef ?? null : null)
            }
            : state;
    }

    private publish(state: RallarRoomEntry.State): RallarRoomEntry.State {
        this.state = state;
        this.notifications.publishLatest(state);
        return this.state;
    }
}

export function readRoomEntryDestination(
    url: string,
    scope: StateScope
): Either<RallarRoomEntry.Failure, RallarRoomEntry.Destination | null> {
    return readEntryUrl(url).flatMap<RallarRoomEntry.Failure, RallarRoomEntry.Destination | null>(
        Either.ofLeft,
        (parsed) => {
            if (!parsed.hash.startsWith('#rallar-room')) {
                return Either.ofRight(null);
            }
            if (!parsed.hash.startsWith(ENTRY_FRAGMENT)) {
                return Either.ofLeft(invalidDestination());
            }
            const fragment = parsed.hash.slice(ENTRY_FRAGMENT.length);
            if (Try.compute(() => decodeURIComponent(fragment)).left) {
                return Either.ofLeft(invalidDestination());
            }
            const fields = new URLSearchParams(fragment);
            if ([...fields.keys()].some((key) => !ENTRY_FIELDS.has(key) || fields.getAll(key).length !== 1)) {
                return Either.ofLeft(invalidDestination());
            }
            return decodeScopedDestination({
                roomRef: {
                    applicationId: fields.get('applicationId'),
                    workspaceId: fields.get('workspaceId'),
                    groupId: fields.get('groupId')
                },
                joinCode: fields.get('joinCode'),
                participation: fields.get('participation') ?? 'preserve'
            }, scope);
        }
    );
}

export function toRoomEntryUrl(
    url: string,
    destination: RallarRoomEntry.Destination
): Either<RallarRoomEntry.Failure, string> {
    return decodeRoomEntryDestination(destination).flatMap<RallarRoomEntry.Failure, string>(
        Either.ofLeft,
        (validated) =>
            readEntryUrl(url).mapRight((base) => {
                const fields = new URLSearchParams({
                    applicationId: validated.roomRef.applicationId,
                    workspaceId: validated.roomRef.workspaceId,
                    groupId: validated.roomRef.groupId,
                    participation: validated.participation
                });
                if (validated.joinCode !== null) {
                    fields.set('joinCode', validated.joinCode);
                }
                base.search = '';
                base.hash = ENTRY_FRAGMENT + fields.toString();
                return base.href;
            })
    );
}

function readEntryUrl(url: string): Either<RallarRoomEntry.Failure, URL> {
    return Try.compute(() => new URL(url)).flatMap(
        () => Either.ofLeft(invalidDestination()),
        (parsed) =>
            (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password
                ? Either.ofRight(parsed)
                : Either.ofLeft(invalidDestination())
    );
}

function decodeSavedEntry(
    value: string,
    scope: StateScope
): Either<RallarRoomEntry.Failure, RallarRoomEntry.SavedEntry> {
    const parsed = Try.compute<unknown>(() => JSON.parse(value));
    return parsed.flatMap<RallarRoomEntry.Failure, RallarRoomEntry.SavedEntry>(
        () => Either.ofLeft(invalidDestination('The saved room destination is invalid.')),
        (entry) => {
            if (!entry || typeof entry !== 'object' || !('destination' in entry) || !('principalId' in entry)) {
                return Either.ofLeft(invalidDestination());
            }
            const principalId = entry.principalId;
            if (principalId !== null && (typeof principalId !== 'string' || principalId.trim().length === 0)) {
                return Either.ofLeft(invalidDestination());
            }
            return decodeScopedDestination(entry.destination, scope).flatMap<
                RallarRoomEntry.Failure,
                RallarRoomEntry.SavedEntry
            >(
                Either.ofLeft,
                (destination) =>
                    principalId !== null && destination.joinCode !== null
                        ? Either.ofLeft(invalidDestination())
                        : Either.ofRight({ destination, principalId })
            );
        }
    );
}

function storageFailure(admittedRoom: GroupRef | null): RallarRoomEntry.Failure {
    return {
        kind: 'storage',
        message: 'Could not save the room destination in this tab. Keep the invitation and retry.',
        admittedRoom
    };
}

function toEntryFailure(error: Error, destination: RallarRoomEntry.Destination): RallarRoomEntry.Failure {
    if (
        'joinedRoom' in error && error.joinedRoom && typeof error.joinedRoom === 'object' &&
        'group' in error.joinedRoom
    ) {
        const admitted =
            decodeRoomEntryDestination({ roomRef: error.joinedRoom.group, joinCode: null, participation: 'preserve' })
                .right;
        if (admitted && isSameGroupRef(admitted.roomRef, destination.roomRef)) {
            return {
                kind: 'partial',
                message: error.name === 'RallarRoomSwitchPartialFailureError'
                    ? 'You entered this room, but leaving the previous room failed. Membership there may remain.'
                    : 'Room admission succeeded, but finishing entry failed. Retry to reconnect.',
                admittedRoom: admitted.roomRef
            };
        }
    }
    if (error instanceof ApiHttpError && error.status >= 400 && error.status < 500) {
        return {
            kind: 'denied',
            message: 'Room entry was denied. Check that the room and invitation or code are still valid.',
            admittedRoom: null
        };
    }
    return {
        kind: 'transport',
        message: 'Could not enter the room. Check your connection and retry.',
        admittedRoom: null
    };
}
