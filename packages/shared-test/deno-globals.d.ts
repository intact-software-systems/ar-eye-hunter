declare const Deno: {
    mkdir(path: string | URL, options?: { recursive?: boolean }): Promise<void>;
    writeTextFile(path: string | URL, data: string): Promise<void>;
};
