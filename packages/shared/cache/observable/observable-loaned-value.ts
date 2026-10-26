import {
    LoanedValue,
    type LoanedValueOptions,
    type LoanedValueRefresh
} from '../LoanedValue.ts';
import type { ReadableValue } from '../ReadableValue.ts';
import {
    ObservableValueEventType,
    type ObservableValue,
    type ObservableValueErrorHandler,
    type ObservableValueEvent,
    type ObservableValueListener,
    type Unsubscribe
} from '../RepositoryInterfaces.ts';
import type { ValueEqualityChecker } from './observable-latest-value.ts';
import { QueuedNotifications } from './queued-notifications.ts';

export type ObservableLoanedValueOptions<T> =
    & LoanedValueOptions<T>
    & Readonly<{
        equals?: ValueEqualityChecker<T>;
        onObserverError?: ObservableValueErrorHandler<T>;
    }>;

export class ObservableLoanedValue<T> implements ReadableValue<T>, ObservableValue<T> {
    private readonly loaned: LoanedValue<T>;
    private readonly equals: ValueEqualityChecker<T>;
    private readonly notifications: QueuedNotifications<ObservableValueEvent<T>>;
    private observedRefresh: Promise<T> | undefined;

    public constructor(
        refresher: LoanedValueRefresh<T>,
        options: ObservableLoanedValueOptions<T> = {}
    ) {
        this.loaned = new LoanedValue<T>(refresher, options);
        this.equals = options.equals ?? Object.is;
        this.notifications = new QueuedNotifications(options.onObserverError);
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
            this.notifications.publish({
                type: ObservableValueEventType.Deleted,
                previous,
                atEpochMs: Date.now()
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
            this.notifications.publish({
                type: ObservableValueEventType.Deleted,
                previous,
                atEpochMs: Date.now()
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
            this.notifications.publish({
                type: ObservableValueEventType.Deleted,
                previous,
                atEpochMs: Date.now()
            });
        }
    }

    public onCreatedDo(listener: ObservableValueListener<T>): Unsubscribe {
        return this.notifications.subscribeType(ObservableValueEventType.Created, listener);
    }

    public onUpdatedDo(listener: ObservableValueListener<T>): Unsubscribe {
        return this.notifications.subscribeType(ObservableValueEventType.Updated, listener);
    }

    public onRefreshedDo(listener: ObservableValueListener<T>): Unsubscribe {
        return this.notifications.subscribeType(ObservableValueEventType.Refreshed, listener);
    }

    public onDeletedDo(listener: ObservableValueListener<T>): Unsubscribe {
        return this.notifications.subscribeType(ObservableValueEventType.Deleted, listener);
    }

    public onChangeDo(listener: ObservableValueListener<T>): Unsubscribe {
        return this.notifications.subscribe(listener);
    }

    public async whenIdle(): Promise<void> {
        while (true) {
            const refresh = this.observedRefresh;
            if (refresh) {
                await refresh.catch(() => undefined);
            }

            const pending = this.notifications.completion;
            await pending;
            await Promise.resolve();

            if (refresh === this.observedRefresh && pending === this.notifications.completion) {
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
                this.notifications.publish(this.toWriteEvent(hadValue, previous, value));
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

    private toWriteEvent(
        hadValue: boolean,
        previous: T | undefined,
        value: T
    ): ObservableValueEvent<T> {
        if (!hadValue) {
            return {
                type: ObservableValueEventType.Created,
                value,
                atEpochMs: Date.now()
            };
        }

        return {
            type: previous !== undefined && this.equals(previous, value)
                ? ObservableValueEventType.Refreshed
                : ObservableValueEventType.Updated,
            value,
            previous,
            atEpochMs: Date.now()
        };
    }
}
