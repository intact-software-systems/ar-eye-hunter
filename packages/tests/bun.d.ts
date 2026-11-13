// Minimal ambient surface for the `Bun` global used by imported runners
// (control-artifact-storage.ts, api-v1-black-box-run.mts, api-v1-managed-process-lifecycle.mts).
// bun-types' own declaration also augments the global `fetch` with Bun-only members, which breaks
// the vitest `typeof fetch` mocks in this project, so we declare only the two APIs those runners
// call instead of loading `types: ["bun"]` project-wide.
declare var Bun: {
    file(path: string): {
        stream(): ReadableStream<Uint8Array>;
    };
    spawn(input: {
        cmd: readonly string[];
        cwd: string;
        env: Record<string, string>;
        stdout: 'pipe';
        stderr: 'pipe';
    }): {
        stdout: ReadableStream<Uint8Array> | null;
        stderr: ReadableStream<Uint8Array> | null;
        exited: Promise<number>;
        kill(signo?: NodeJS.Signals): void;
    };
};
