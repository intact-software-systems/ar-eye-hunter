import {
    LatestValue,
    type LatestValueOptions,
    type ValueSink
} from '../LatestValue.ts';
import type { ReadableValue } from '../ReadableValue.ts';
import {
    ObservableValueEventType,
    type ObservableValue,
    type ObservableValueErrorHandler,
    type ObservableValueEvent,
    type ObservableValueListener,
    type Unsubscribe
} from '../RepositoryInterfaces.ts';
import { QueuedNotifications } from './queued-notifications.ts';

export type ValueEqualityChecker<T> = (left: T, right: T) => boolean;

export type ObservableLatestValueOptions<T> =
    & LatestValueOptions<T>
    & Readonly<{
        equals?: ValueEqualityChecker<T>;
        onObserverError?: ObservableValueErrorHandler<T>;
    }>;

export class ObservableLatestValue<T> implements ReadableValue<T>, ValueSink<T>, ObservableValue<T> {
    private readonly latest: LatestValue<T>;
    private readonly equals: ValueEqualityChecker<T>;
    private readonly notifications: QueuedNotifications<ObservableValueEvent<T>>;

    constructor(options: ObservableLatestValueOptions<T> = {}) {
        this.latest = new LatestValue<T>(options);
        this.equals = options.equals ?? Object.is;
        this.notifications = new QueuedNotifications(options.onObserverError);
    }

    public accept(value: T): void {
        const previous = this.latest.peek();
        const hadValue = this.latest.hasValue();

        this.latest.accept(value);
        this.notifications.publish(this.toWriteEvent(hadValue, previous, value));
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

    public readExpiresAtEpochMs(): number | undefined {
        return this.latest.readExpiresAtEpochMs();
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
            this.notifications.publish(this.toWriteEvent(hadValue, previous, update));
        }

        return updated;
    }

    public getAndSet(update: T): T | undefined {
        const previous = this.latest.getAndSet(update);
        this.notifications.publish(this.toWriteEvent(previous !== undefined, previous, update));
        return previous;
    }

    public touch(): boolean {
        const current = this.latest.peek();
        const touched = this.latest.touch();

        if (touched) {
            this.notifications.publish({
                type: ObservableValueEventType.Refreshed,
                value: current,
                previous: current,
                atEpochMs: Date.now()
            });
        }

        return touched;
    }

    public take(): T | undefined {
        const previous = this.latest.peek();
        const hadValue = this.latest.hasValue();
        const value = this.latest.take();

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
        const previous = this.latest.peek();
        const hadValue = this.latest.hasValue();
        const wasExpired = this.latest.expired();
        const value = this.latest.takeIfExpired();

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

    public whenIdle(): Promise<void> {
        return this.notifications.whenIdle();
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
