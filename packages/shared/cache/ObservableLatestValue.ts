import { LatestValue, type LatestValueOptions, type ValueSink, } from './LatestValue.ts';
import type { ReadableValue } from './ReadableValue.ts';
import {
    type ObservableValue,
    type ObservableValueErrorHandler,
    type ObservableValueEvent,
    ObservableValueEventType,
    type ObservableValueListener,
    type Unsubscribe,
} from './RepositoryInterfaces.ts';

export { ObservableValueEventType } from './RepositoryInterfaces.ts';
export type {
    ObservableValue,
    ObservableValueErrorHandler,
    ObservableValueEvent,
    ObservableValueListener,
    Unsubscribe,
} from './RepositoryInterfaces.ts';

export type ValueEqualityChecker<T> = (left: T, right: T) => boolean;

export type ObservableLatestValueOptions<T> = LatestValueOptions<T> & Readonly<{
    equals?: ValueEqualityChecker<T>;
    onObserverError?: ObservableValueErrorHandler<T>;
}>;

const defaultEquals = <T>(left: T, right: T): boolean => Object.is(left, right);

export class ObservableLatestValue<T>
    implements ReadableValue<T>, ValueSink<T>, ObservableValue<T> {
    private readonly latest: LatestValue<T>;
    private readonly equals: ValueEqualityChecker<T>;
    private readonly onObserverError?: ObservableValueErrorHandler<T>;
    private readonly listenersByType = new Map<
        ObservableValueEventType,
        Set<ObservableValueListener<T>>
    >();
    private readonly changeListeners = new Set<ObservableValueListener<T>>();
    private observerQueue: Promise<void> = Promise.resolve();

    constructor(options: ObservableLatestValueOptions<T> = {}) {
        this.latest = new LatestValue<T>(options);
        this.equals = options.equals ?? defaultEquals;
        this.onObserverError = options.onObserverError;
    }

    public accept(value: T): void {
        const previous = this.latest.peek();
        const hadValue = this.latest.hasValue();

        this.latest.accept(value);
        this.emit(this.toWriteEvent(hadValue, previous, value));
    }

    public async acceptAndNotify(value: T): Promise<void> {
        this.accept(value);
        await this.whenIdle();
    }

    public next(value: T): void {
        this.accept(value);
    }

    public set(value: T): this {
        this.accept(value);
        return this;
    }

    public asCallback(): (value: T) => void {
        return (value: T) => {
            this.accept(value);
        };
    }

    public read(): T | undefined {
        return this.latest.read();
    }

    public peek(): T | undefined {
        return this.latest.peek();
    }

    public get(): T {
        return this.latest.get();
    }

    public getOrElse(fallback: T): T {
        return this.latest.getOrElse(fallback);
    }

    public getOrElseGet(factory: () => T): T {
        return this.latest.getOrElseGet(factory);
    }

    public compareAndSet(expect: T | undefined, update: T): boolean {
        const previous = this.latest.peek();
        const hadValue = this.latest.hasValue();
        const updated = this.latest.compareAndSet(expect, update);

        if (updated) {
            this.emit(this.toWriteEvent(hadValue, previous, update));
        }

        return updated;
    }

    public getAndSet(update: T): T | undefined {
        const previous = this.latest.getAndSet(update);
        this.emit(this.toWriteEvent(previous !== undefined, previous, update));
        return previous;
    }

    public touch(): boolean {
        const current = this.latest.peek();
        const touched = this.latest.touch();

        if (touched) {
            this.emit({
                type: ObservableValueEventType.Refreshed,
                value: current,
                previous: current,
                atEpochMs: Date.now(),
            });
        }

        return touched;
    }

    public take(): T | undefined {
        const previous = this.latest.peek();
        const hadValue = this.latest.hasValue();
        const value = this.latest.take();

        if (hadValue) {
            this.emit({
                type: ObservableValueEventType.Deleted,
                previous,
                atEpochMs: Date.now(),
            });
        }

        return value;
    }

    public takeIfExpired(): T | undefined {
        const previous = this.latest.peek();
        const hadValue = this.latest.hasValue();
        const wasExpired = this.latest.expired();
        const value = this.latest.takeIfExpired();

        if (hadValue && wasExpired) {
            this.emit({
                type: ObservableValueEventType.Deleted,
                previous,
                atEpochMs: Date.now(),
            });
        }

        return value;
    }

    public hasValue(): boolean {
        return this.latest.hasValue();
    }

    public expired(): boolean {
        return this.latest.expired();
    }

    public refreshing(): boolean {
        return this.latest.refreshing();
    }

    public clear(): void {
        const previous = this.latest.peek();
        const hadValue = this.latest.hasValue();

        this.latest.clear();

        if (hadValue) {
            this.emit({
                type: ObservableValueEventType.Deleted,
                previous,
                atEpochMs: Date.now(),
            });
        }
    }

    public onCreatedDo(listener: ObservableValueListener<T>): Unsubscribe {
        return this.onTypeDo(ObservableValueEventType.Created, listener);
    }

    public onUpdatedDo(listener: ObservableValueListener<T>): Unsubscribe {
        return this.onTypeDo(ObservableValueEventType.Updated, listener);
    }

    public onRefreshedDo(listener: ObservableValueListener<T>): Unsubscribe {
        return this.onTypeDo(ObservableValueEventType.Refreshed, listener);
    }

    public onDeletedDo(listener: ObservableValueListener<T>): Unsubscribe {
        return this.onTypeDo(ObservableValueEventType.Deleted, listener);
    }

    public onChangeDo(listener: ObservableValueListener<T>): Unsubscribe {
        this.changeListeners.add(listener);
        return toUnsubscribe(() => {
            this.changeListeners.delete(listener);
        });
    }

    public async whenIdle(): Promise<void> {
        let pending = this.observerQueue;

        while (true) {
            await pending;

            if (pending === this.observerQueue) {
                return;
            }

            pending = this.observerQueue;
        }
    }

    private onTypeDo(
        type: ObservableValueEventType,
        listener: ObservableValueListener<T>,
    ): Unsubscribe {
        let listeners = this.listenersByType.get(type);
        if (!listeners) {
            listeners = new Set<ObservableValueListener<T>>();
            this.listenersByType.set(type, listeners);
        }

        listeners.add(listener);
        return toUnsubscribe(() => {
            listeners?.delete(listener);
            if (listeners?.size === 0) {
                this.listenersByType.delete(type);
            }
        });
    }

    private toWriteEvent(
        hadValue: boolean,
        previous: T | undefined,
        value: T,
    ): ObservableValueEvent<T> {
        if (!hadValue) {
            return {
                type: ObservableValueEventType.Created,
                value,
                atEpochMs: Date.now(),
            };
        }

        return {
            type: previous !== undefined && this.equals(previous, value)
                ? ObservableValueEventType.Refreshed
                : ObservableValueEventType.Updated,
            value,
            previous,
            atEpochMs: Date.now(),
        };
    }

    private emit(event: ObservableValueEvent<T>): void {
        const listeners = [
            ...(this.listenersByType.get(event.type) ?? []),
            ...this.changeListeners,
        ];

        if (listeners.length === 0) {
            return;
        }

        this.observerQueue = this.observerQueue.then(
            async () => {
                await Promise.all(
                    listeners.map(async (listener) => {
                        await this.notifyListener(listener, event);
                    }),
                );
            },
            async () => {
                await Promise.all(
                    listeners.map(async (listener) => {
                        await this.notifyListener(listener, event);
                    }),
                );
            },
        );
    }

    private async notifyListener(
        listener: ObservableValueListener<T>,
        event: ObservableValueEvent<T>,
    ): Promise<void> {
        try {
            await listener(event);
        } catch (error) {
            await this.handleObserverError(error, event);
        }
    }

    private async handleObserverError(
        error: unknown,
        event: ObservableValueEvent<T>,
    ): Promise<void> {
        if (this.onObserverError) {
            try {
                await this.onObserverError(error, event);
            } catch (handlerError) {
                console.error('Error handling observable value observer failure', handlerError);
            }
            return;
        }

        console.error('Error notifying observable value listener', error);
    }
}

function toUnsubscribe(unsubscribe: () => void): Unsubscribe {
    let active = true;
    return {
        unsubscribe: () => {
            if (!active) {
                return;
            }

            active = false;
            unsubscribe();
        },
    };
}
