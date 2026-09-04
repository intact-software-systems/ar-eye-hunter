declare module 'node:util' {
    export const types: Readonly<{
        isProxy(value: object): boolean;
    }>;
}
