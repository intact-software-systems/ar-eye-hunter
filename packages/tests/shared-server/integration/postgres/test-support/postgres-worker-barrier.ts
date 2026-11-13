import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';

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
                for (const _entry of await readdir(readyDirectoryPath, { withFileTypes: true })) {
                    markerCount += 1;
                }
                if (markerCount >= participantCount) {
                    return;
                }
            }
            catch (error) {
                if (!isNotFound(error)) {
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
    await mkdir(barrier.readyDirectoryPath, { recursive: true });
    await writeFile(
        `${barrier.readyDirectoryPath}/${encodeURIComponent(participantId)}.json`,
        JSON.stringify({ workerPid: process.pid })
    );
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        try {
            await stat(barrier.releaseFilePath);
            return;
        }
        catch (error) {
            if (!isNotFound(error)) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }
    throw new Error(`Timed out waiting for worker barrier release: ${barrier.releaseFilePath}`);
}

function isNotFound(error: unknown): boolean {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
