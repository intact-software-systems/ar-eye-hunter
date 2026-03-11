export interface ReadableValue<T> {
    read(): T | undefined;

    peek(): T | undefined;

    hasValue(): boolean;

    expired(): boolean;

    refreshing(): boolean;

    take(): T | undefined;

    takeIfExpired(): T | undefined;

    clear(): void;
}