// shared-server intentionally excludes ambient Node types. Node and Bun both provide this
// runtime API, which lets computed-data validation reject proxies without invoking their traps.
declare module 'node:util' {
    export const types: Readonly<{
        isProxy(value: object): boolean;
        isDataView(value: object): boolean;
    }>;
}
