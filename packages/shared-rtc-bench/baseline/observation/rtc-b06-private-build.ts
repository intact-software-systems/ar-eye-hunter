import type { RtcBaselineAttemptLocatorDto } from '../contracts/rtc-baseline-contracts.ts';
import type { RtcBaselineDenoPort } from '../runtime/rtc-baseline-deno-port.ts';

export interface RtcB06PrivateBuildInput {
    readonly repositoryRoot: string;
    readonly baselineId: string;
    readonly attempt: Pick<RtcBaselineAttemptLocatorDto, 'caseId' | 'intendedPhase' | 'outerOrdinal'>;
}

interface RtcB06PrivateBuildDirectoryIdentity {
    readonly path: string;
    readonly dev: number;
    readonly ino: number;
}

export interface RtcB06PrivateBuildOwnership {
    readonly buildRoot: string;
    readonly directories: readonly RtcB06PrivateBuildDirectoryIdentity[];
}

export async function allocateRtcB06PrivateBuild(
    runtime: Pick<RtcBaselineDenoPort, 'lstat' | 'mkdir' | 'errors'>,
    input: RtcB06PrivateBuildInput
): Promise<RtcB06PrivateBuildOwnership> {
    const buildRoot = toRtcB06PrivateBuildDirectory(input);
    const segments = buildRoot.slice(input.repositoryRoot.length + 1).split('/');
    if (
        !input.repositoryRoot.startsWith('/') ||
        segments.some((segment) => !/^[a-zA-Z0-9._-]+$/.test(segment) || segment === '.' || segment === '..')
    ) {
        throw new Error('Private production build path is not confined.');
    }
    const directories = [await readRtcB06PrivateBuildDirectoryIdentity(runtime, input.repositoryRoot)];
    let path = input.repositoryRoot;
    for (const segment of segments.slice(0, -1)) {
        path += `/${segment}`;
        let identity: RtcB06PrivateBuildDirectoryIdentity;
        try {
            identity = await readRtcB06PrivateBuildDirectoryIdentity(runtime, path);
        }
        catch (error) {
            if (!runtime.errors?.NotFound || !(error instanceof runtime.errors.NotFound)) {
                throw error;
            }
            await verifyRtcB06PrivateBuildOwnership(runtime, directories);
            await runtime.mkdir(path, { recursive: false });
            identity = await readRtcB06PrivateBuildDirectoryIdentity(runtime, path);
        }
        directories.push(identity);
    }
    await verifyRtcB06PrivateBuildOwnership(runtime, directories);
    await runtime.mkdir(buildRoot, { recursive: false });
    directories.push(await readRtcB06PrivateBuildDirectoryIdentity(runtime, buildRoot));
    return { buildRoot, directories };
}

async function readRtcB06PrivateBuildDirectoryIdentity(
    runtime: Pick<RtcBaselineDenoPort, 'lstat'>,
    path: string
): Promise<RtcB06PrivateBuildDirectoryIdentity> {
    const info = await runtime.lstat(path);
    if (!info.isDirectory || info.isSymlink || info.dev === null || info.ino === null) {
        throw new Error('Private production build path is not confined.');
    }
    return { path, dev: info.dev, ino: info.ino };
}

export async function verifyRtcB06PrivateBuildOwnership(
    runtime: Pick<RtcBaselineDenoPort, 'lstat'>,
    directories: readonly RtcB06PrivateBuildDirectoryIdentity[]
): Promise<void> {
    for (const expected of directories) {
        const current = await readRtcB06PrivateBuildDirectoryIdentity(runtime, expected.path);
        if (current.dev !== expected.dev || current.ino !== expected.ino) {
            throw new Error('Private production build directory ownership changed.');
        }
    }
}

export function toRtcB06PrivateBuildDirectory(input: RtcB06PrivateBuildInput) {
    return `${input.repositoryRoot}/tmp/perf/rtc-b06-private-build/${input.baselineId}/${input.attempt.caseId}/${input.attempt.intendedPhase}-${input.attempt.outerOrdinal}`;
}
