let kvPromise: Promise<Deno.Kv> | undefined = undefined;

export function getKv(): Promise<Deno.Kv> {
    if (!kvPromise) {
        kvPromise = Deno.openKv();
    }
    return kvPromise;
}
