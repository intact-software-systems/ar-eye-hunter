export interface WorkerBarrier {
    readonly readyDirectoryPath: string;
    readonly releaseFilePath: string;
}

export async function waitForPostgresAppInboxWorkerParticipants<T>(
    readyDirectoryPath: string,
    participantCount: number,
    workerDone: readonly Promise<T>[]
): Promise<void> {
    const waitForMarkers = async (): Promise<void> => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            try {
                let markerCount = 0;
                for await (const _entry of Deno.readDir(readyDirectoryPath)) {
                    markerCount += 1;
                }
                if (markerCount >= participantCount) {
                    return;
                }
            }
            catch (error) {
                if (!(error instanceof Deno.errors.NotFound)) {
                    throw error;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Timed out waiting for AppInbox workers: ${readyDirectoryPath}`);
    };
    await Promise.race([
        waitForMarkers(),
        Promise.race(workerDone).then(() => {
            throw new Error(`AppInbox worker exited before barrier: ${readyDirectoryPath}`);
        })
    ]);
}

export async function waitForPostgresWorkerBarrier(
    barrier: WorkerBarrier,
    participantId: string
): Promise<void> {
    await Deno.mkdir(barrier.readyDirectoryPath, { recursive: true });
    await Deno.writeTextFile(
        `${barrier.readyDirectoryPath}/${encodeURIComponent(participantId)}.json`,
        JSON.stringify({ workerPid: Deno.pid })
    );
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        try {
            await Deno.stat(barrier.releaseFilePath);
            return;
        }
        catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }
    throw new Error(`Timed out waiting for worker barrier release: ${barrier.releaseFilePath}`);
}
