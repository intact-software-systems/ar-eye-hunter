// shared-server intentionally excludes ambient Node types. Node and Deno both provide this
// synchronous runtime API, which the synchronous limiter lookup needs to hash over-length keys.
declare module 'node:crypto' {
    export function createHash(algorithm: 'sha256'): {
        update(value: string): { digest(encoding: 'hex'): string; };
    };
}
