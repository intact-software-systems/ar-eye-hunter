declare module 'node:util' {
    export const types: Readonly<{
        isDate(value: unknown): value is Date;
        isNativeError(value: unknown): value is Error;
        isProxy(value: unknown): boolean;
        isTypedArray(value: unknown): value is ArrayBufferView;
    }>;
}
