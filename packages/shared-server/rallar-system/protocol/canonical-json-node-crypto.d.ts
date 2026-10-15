// shared-server intentionally excludes ambient Node types. Node and Deno both provide this
// runtime API, which lets canonical identity hashing stay synchronous inside pure compute phases.
declare module 'node:crypto' {
    export interface Sha256Hash {
        update(data: string, inputEncoding: 'utf8'): Sha256Hash;
        digest(encoding: 'hex'): string;
    }

    export function createHash(algorithm: 'sha256'): Sha256Hash;
}
