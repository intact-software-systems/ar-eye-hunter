import type { RtcBaselineExclusiveFileLock } from '../evidence/rtc-baseline-file-port.ts';
import type { RtcBaselineDenoFile, RtcBaselineDenoPort } from './rtc-baseline-deno-port.ts';

const maximumMetadataBytes = 65_536;

function requireRegularFile(value: { isFile: boolean; isSymlink: boolean; }) {
    if (value.isSymlink) {
        throw new Error('Writer lock path may not be a symbolic link.');
    }
    if (!value.isFile) {
        throw new Error('Writer lock path must be a regular file.');
    }
}

function sameFileIdentity(
    pathFile: { dev: number | null; ino: number | null; },
    openedFile: { dev: number | null; ino: number | null; }
) {
    return (
        pathFile.dev !== null &&
        pathFile.ino !== null &&
        openedFile.dev !== null &&
        openedFile.ino !== null &&
        pathFile.dev === openedFile.dev &&
        pathFile.ino === openedFile.ino
    );
}

async function readMetadata(file: RtcBaselineDenoFile) {
    const { size } = await file.stat();
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumMetadataBytes) {
        throw new Error(`Writer lock metadata must not exceed ${maximumMetadataBytes} bytes.`);
    }
    const bytes = new Uint8Array(size);
    await file.seek(0, 0);
    let offset = 0;
    while (offset < bytes.length) {
        const read = await file.read(bytes.subarray(offset));
        if (read === null) {
            break;
        }
        if (read === 0) {
            throw new Error('Writer lock metadata read made no progress.');
        }
        offset += read;
    }
    return offset === bytes.length ? bytes : bytes.slice(0, offset);
}

async function writeMetadata(file: RtcBaselineDenoFile, bytes: Uint8Array) {
    await file.seek(0, 0);
    let offset = 0;
    while (offset < bytes.length) {
        const written = await file.write(bytes.subarray(offset));
        if (written === 0) {
            throw new Error('Writer lock metadata write made no progress.');
        }
        offset += written;
    }
    await file.truncate(bytes.length);
    await file.sync();
}

async function openWriterLock(runtime: RtcBaselineDenoPort, path: string) {
    try {
        const file = await runtime.open(path, { read: true, write: true, createNew: true });
        return { file, created: true };
    }
    catch (error) {
        const AlreadyExists = runtime.errors?.AlreadyExists;
        if (!AlreadyExists || !(error instanceof AlreadyExists)) {
            throw error;
        }
    }
    requireRegularFile(await runtime.lstat(path));
    return {
        file: await runtime.open(path, { read: true, write: true }),
        created: false
    };
}

async function verifyOpenedPath(
    runtime: RtcBaselineDenoPort,
    path: string,
    file: RtcBaselineDenoFile
) {
    const openedFile = await file.stat();
    const pathFile = await runtime.lstat(path);
    requireRegularFile(openedFile);
    requireRegularFile(pathFile);
    if (!sameFileIdentity(pathFile, openedFile)) {
        throw new Error('Writer lock path changed while it was being opened.');
    }
}

export async function tryAcquireRtcBaselineDenoWriterLock(
    runtime: RtcBaselineDenoPort,
    path: string
): Promise<RtcBaselineExclusiveFileLock | null> {
    const { file, created } = await openWriterLock(runtime, path);
    try {
        await verifyOpenedPath(runtime, path, file);
        if (created) {
            await file.lock(true);
        }
        else if (!(await file.tryLock(true))) {
            file.close();
            return null;
        }
        await verifyOpenedPath(runtime, path, file);
    }
    catch (error) {
        file.close();
        throw error;
    }
    let released = false;
    return {
        created,
        readBytes: () => readMetadata(file),
        writeBytes: (bytes) => writeMetadata(file, bytes),
        async release() {
            if (released) {
                return;
            }
            released = true;
            try {
                await file.unlock();
            }
            finally {
                file.close();
            }
        }
    };
}
