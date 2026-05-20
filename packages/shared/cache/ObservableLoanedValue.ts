import {
    LoanedValue,
    type LoanedValueOptions,
    type LoanedValueRefresh,
} from './LoanedValue.ts';
import type { ReadableValue } from './ReadableValue.ts';
import type { ValueEqualityChecker } from './ObservableLatestValue.ts';
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

export type ObservableLoanedValueOptions<T> = LoanedValueOptions<T> & Readonly<{
    equals?: ValueEqualityChecker<T>;
    onObserverError?: ObservableValueErrorHandler<T>;
}>;

const defaultEquals = <T>(left: T, right: T): boolean => Object.is(left, right);

export class ObservableLoanedValue<T>
    implements ReadableValue<T>, ObservableValue<T> {
    private readonly loaned: LoanedValue<T>;
    private readonly equals: ValueEqualityChecker<T>;
    private readonly onObserverError?: ObservableValueErrorHandler<T>;
    private readonly listenersByType = new Map<
        ObservableValueEventType,
        Set<ObservableValueListener<T>>
    >();
    private readonly changeListeners = new Set<ObservableValueListener<T>>();
    private observerQueue: Promise<void> = Promise.resolve();
    private observedRefresh: Promise<T> | undefined;

    public constructor(
        refresher: LoanedValueRefresh<T>,
        options: ObservableLoanedValueOptions<T> = {},
    ) {
        this.loaned = new LoanedValue<T>(refresher, options);
        this.equals = options.equals ?? defaultEquals;
        this.onObserverError = options.onObserverError;
    }

    public read(): T | undefined {
        return this.loaned.read();
    }

    public peek(): T | undefined {
        return this.loaned.peek();
    }

    public async get(): Promise<T> {
        if (!this.loaned.expired()) {
            return this.loaned.get();
        }

        return this.runObservedRefresh(() => this.loaned.get());
    }

    public async getWith(refresher: LoanedValueRefresh<T>): Promise<T> {
        if (!this.loaned.expired()) {
            return this.loaned.getWith(refresher);
        }

        return this.runObservedRefresh(() => this.loaned.getWith(refresher));
    }

    public async refresh(): Promise<T> {
        return this.runObservedRefresh(() => this.loaned.refresh());
    }

    public async refreshWith(refresher: LoanedValueRefresh<T>): Promise<T> {
        return this.runObservedRefresh(() => this.loaned.refreshWith(refresher));
    }

    public take(): T | undefined {
        const previous = this.loaned.peek();
        const hadValue = this.loaned.hasValue();
        const value = this.loaned.take();

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
        const previous = this.loaned.peek();
        const hadValue = this.loaned.hasValue();
        const wasExpired = this.loaned.expired();
        const value = this.loaned.takeIfExpired();

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
        return this.loaned.hasValue();
    }

    public expired(): boolean {
        return this.loaned.expired();
    }

    public refreshing(): boolean {
        return this.loaned.refreshing();
    }

    public clear(): void {
        const previous = this.loaned.peek();
        const hadValue = this.loaned.hasValue();

        this.loaned.clear();

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
        while (true) {
            const refresh = this.observedRefresh;
            if (refresh) {
                await refresh.catch(() => undefined);
            }

            const pending = this.observerQueue;
            await pending;
            await Promise.resolve();

            if (refresh === this.observedRefresh && pending === this.observerQueue) {
                return;
            }
        }
    }

    private runObservedRefresh(operation: () => Promise<T>): Promise<T> {
        if (this.observedRefresh) {
            return this.observedRefresh;
        }

        const previous = this.loaned.peek();
        const hadValue = this.loaned.hasValue();
        const refresh = Promise.resolve()
            .then(operation)
            .then((value) => {
                this.emit(this.toWriteEvent(hadValue, previous, value));
                return value;
            })
            .finally(() => {
                if (this.observedRefresh === refresh) {
                    this.observedRefresh = undefined;
                }
            });

        this.observedRefresh = refresh;
        return refresh;
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
                console.error('Error handling observable loaned value observer failure', handlerError);
            }
            return;
        }

        console.error('Error notifying observable loaned value listener', error);
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
