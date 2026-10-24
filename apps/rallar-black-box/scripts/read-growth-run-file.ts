import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * A sampler that never wrote a file leaves its readings absent, which the verdict reports as no data. Any other read
 * failure, and a file past `maxBytes`, stops the verdict instead of reading as no data.
 */
export async function readGrowthRunFile(runDir: string, fileName: string, maxBytes: number): Promise<string> {
    const filePath = path.join(runDir, fileName);
    const size = await readFileSize(filePath);
    if (size === undefined) {
        return '';
    }
    if (size > maxBytes) {
        throw new Error(`${filePath} holds ${size} bytes, past the ${maxBytes} the verdict reads whole`);
    }
    return await readFile(filePath, 'utf8');
}

/** Undefined for a file that does not exist. */
async function readFileSize(filePath: string): Promise<number | undefined> {
    try {
        return (await stat(filePath)).size;
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}
