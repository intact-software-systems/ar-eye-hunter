import type { PGlite } from '@electric-sql/pglite';

export const PGLITE_BLACK_BOX_SNAPSHOT_DIR_ENV = 'RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR';

const REQUESTS_DIRECTORY = 'requests';
const RESPONSES_DIRECTORY = 'responses';
const SNAPSHOTS_DIRECTORY = 'snapshots';
const CANCELLATIONS_DIRECTORY = 'cancellations';
const POLL_INTERVAL_MS = 25;

export type PGliteBlackBoxSnapshotPublisher = Readonly<{
    publishPendingSnapshots(): Promise<void>;
    stop(): Promise<void>;
}>;

type SnapshotRequest = Readonly<{
    nonce: string;
    generation: string;
    requestedAtEpochMs: number;
}>;

type SnapshotResponse = Readonly<{
    nonce: string;
    generation: string;
    requestedAtEpochMs: number;
    publishedAtEpochMs: number;
    snapshotFile?: string;
    failure?: string;
}>;

type SnapshotPublicationHooks = Readonly<{
    afterArchive?(request: SnapshotRequest): Promise<void>;
    afterResponse?(response: SnapshotResponse): Promise<void>;
    beforeArchiveRename?(request: SnapshotRequest): Promise<void>;
    beforeArchiveWrite?(request: SnapshotRequest): Promise<void>;
    beforeResponseRename?(response: SnapshotResponse): Promise<void>;
    beforeResponseWrite?(response: SnapshotResponse): Promise<void>;
}>;

type PublishSnapshotInput = Readonly<{
    raw: Pick<PGlite, 'dumpDataDir'>;
    control: SnapshotControlDirectory;
    request: SnapshotRequest;
    publicationHooks: SnapshotPublicationHooks | undefined;
}>;

export async function startPGliteBlackBoxSnapshotPublisher(
    raw: Pick<PGlite, 'dumpDataDir'>,
    options: Readonly<{
        env?: Readonly<{ get(name: string): string | undefined; }>;
        pollIntervalMs?: number;
    }> = {}
): Promise<PGliteBlackBoxSnapshotPublisher | undefined> {
    const publisher = await createPGliteBlackBoxSnapshotPublisher(raw, options);
    if (!publisher) {
        return undefined;
    }

    let stopped = false;
    const poll = (): void => {
        if (stopped) {
            return;
        }
        void publisher.publishPendingSnapshots();
    };
    const interval = setInterval(() => {
        poll();
    }, options.pollIntervalMs ?? POLL_INTERVAL_MS);
    Deno.unrefTimer(interval);
    poll();
    return {
        publishPendingSnapshots: publisher.publishPendingSnapshots,
        stop: async () => {
            stopped = true;
            clearInterval(interval);
            await publisher.publishPendingSnapshots();
        }
    };
}

export async function createPGliteBlackBoxSnapshotPublisher(
    raw: Pick<PGlite, 'dumpDataDir'>,
    options: Readonly<{
        env?: Readonly<{ get(name: string): string | undefined; }>;
        publicationHooks?: SnapshotPublicationHooks;
    }> = {}
): Promise<
    Readonly<{
        publishPendingSnapshots(): Promise<void>;
    }> | undefined
> {
    const snapshotDir = options.env?.get(PGLITE_BLACK_BOX_SNAPSHOT_DIR_ENV) ??
        Deno.env.get(PGLITE_BLACK_BOX_SNAPSHOT_DIR_ENV);
    if (!snapshotDir?.trim()) {
        return undefined;
    }

    const control = new SnapshotControlDirectory(snapshotDir);
    await control.prepare();
    let publishing: Promise<void> | undefined;
    return {
        publishPendingSnapshots: () => {
            if (publishing) {
                return publishing;
            }
            publishing = publishPendingSnapshots(raw, control, options.publicationHooks).finally(() => {
                publishing = undefined;
            });
            return publishing;
        }
    };
}

class SnapshotControlDirectory {
    private readonly root: string;

    constructor(root: string) {
        this.root = root;
    }

    requests(): string {
        return `${this.root}/${REQUESTS_DIRECTORY}`;
    }

    responses(): string {
        return `${this.root}/${RESPONSES_DIRECTORY}`;
    }

    snapshots(): string {
        return `${this.root}/${SNAPSHOTS_DIRECTORY}`;
    }

    response(nonce: string): string {
        return `${this.root}/${RESPONSES_DIRECTORY}/${nonce}.json`;
    }

    snapshot(nonce: string): string {
        return `${this.root}/${SNAPSHOTS_DIRECTORY}/${nonce}.tar`;
    }

    cancellation(nonce: string): string {
        return `${this.root}/${CANCELLATIONS_DIRECTORY}/${nonce}.json`;
    }

    async prepare(): Promise<void> {
        await Deno.mkdir(this.root, { recursive: true, mode: 0o700 });
        await Deno.chmod(this.root, 0o700);
        await Promise.all([
            Deno.mkdir(this.requests(), { recursive: true, mode: 0o700 }),
            Deno.mkdir(this.responses(), { recursive: true, mode: 0o700 }),
            Deno.mkdir(this.snapshots(), { recursive: true, mode: 0o700 }),
            Deno.mkdir(`${this.root}/${CANCELLATIONS_DIRECTORY}`, { recursive: true, mode: 0o700 })
        ]);
        await Promise.all([
            Deno.chmod(this.requests(), 0o700),
            Deno.chmod(this.responses(), 0o700),
            Deno.chmod(this.snapshots(), 0o700),
            Deno.chmod(`${this.root}/${CANCELLATIONS_DIRECTORY}`, 0o700)
        ]);
    }
}

async function publishPendingSnapshots(
    raw: Pick<PGlite, 'dumpDataDir'>,
    control: SnapshotControlDirectory,
    publicationHooks: SnapshotPublicationHooks | undefined
): Promise<void> {
    const requests: string[] = [];
    for await (const entry of Deno.readDir(control.requests())) {
        if (entry.isFile && entry.name.endsWith('.json')) {
            requests.push(entry.name);
        }
    }
    for (const name of requests.sort()) {
        const requestPath = `${control.requests()}/${name}`;
        const request = await readSnapshotRequest(requestPath);
        if (!request) {
            continue;
        }
        await publishSnapshot({ raw, control, request, publicationHooks });
        await Deno.remove(requestPath, { recursive: false }).catch(ignoreNotFound);
    }
}

async function publishSnapshot(input: PublishSnapshotInput): Promise<void> {
    const { raw, control, request, publicationHooks } = input;
    try {
        if (!await canPublishSnapshot(control, request)) {
            await cleanupPublishedSnapshot(control, request.nonce);
            return;
        }
        const dump = await raw.dumpDataDir();
        const temporarySnapshot = `${control.snapshot(request.nonce)}.${crypto.randomUUID()}.part`;
        await publicationHooks?.beforeArchiveWrite?.(request);
        await Deno.writeFile(temporarySnapshot, new Uint8Array(await dump.arrayBuffer()), {
            mode: 0o600
        });
        if (!await canPublishSnapshot(control, request)) {
            await cleanupPublishedSnapshot(control, request.nonce);
            return;
        }
        await publicationHooks?.beforeArchiveRename?.(request);
        await Deno.rename(temporarySnapshot, control.snapshot(request.nonce));
        await publicationHooks?.afterArchive?.(request);
        if (!await canPublishSnapshot(control, request)) {
            await cleanupPublishedSnapshot(control, request.nonce);
            return;
        }
        const response = {
            ...request,
            publishedAtEpochMs: Math.max(Date.now(), request.requestedAtEpochMs + 1),
            snapshotFile: `${request.nonce}.tar`
        };
        await publishResponse(control, response, publicationHooks);
        await publicationHooks?.afterResponse?.(response);
        if (!await canPublishSnapshot(control, request)) {
            await cleanupPublishedSnapshot(control, request.nonce);
        }
    }
    catch (error) {
        await cleanupFailedPublication(control, request.nonce);
        if (!await canPublishSnapshot(control, request)) {
            return;
        }
        try {
            const response = {
                ...request,
                publishedAtEpochMs: Math.max(Date.now(), request.requestedAtEpochMs + 1),
                failure: error instanceof Error ? error.message : String(error)
            };
            await publishResponse(control, response, publicationHooks);
            await publicationHooks?.afterResponse?.(response);
        }
        catch (_responseError) {
            await cleanupPublishedSnapshot(control, request.nonce);
            return;
        }
        if (!await canPublishSnapshot(control, request)) {
            await cleanupPublishedSnapshot(control, request.nonce);
        }
    }
    finally {
        await cleanupSnapshotTransients(control, request.nonce);
    }
}

async function canPublishSnapshot(
    control: SnapshotControlDirectory,
    request: SnapshotRequest
): Promise<boolean> {
    return !await isSnapshotCancelled(control, request.nonce) &&
        await isSnapshotRequestPending(control, request);
}

async function isSnapshotCancelled(
    control: SnapshotControlDirectory,
    nonce: string
): Promise<boolean> {
    try {
        await Deno.stat(control.cancellation(nonce));
        return true;
    }
    catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return false;
        }
        throw error;
    }
}

async function cleanupPublishedSnapshot(
    control: SnapshotControlDirectory,
    nonce: string
): Promise<void> {
    await Promise.all([
        removeSnapshotArtifacts(control.requests(), nonce),
        removeSnapshotArtifacts(control.responses(), nonce),
        removeSnapshotArtifacts(control.snapshots(), nonce)
    ]);
}

async function cleanupSnapshotTransients(
    control: SnapshotControlDirectory,
    nonce: string
): Promise<void> {
    await Promise.all([
        removeSnapshotArtifacts(control.requests(), nonce, true),
        removeSnapshotArtifacts(control.responses(), nonce, true),
        removeSnapshotArtifacts(control.snapshots(), nonce, true)
    ]);
}

async function cleanupFailedPublication(
    control: SnapshotControlDirectory,
    nonce: string
): Promise<void> {
    await Promise.all([
        removeSnapshotArtifacts(control.requests(), nonce, true),
        removeSnapshotArtifacts(control.responses(), nonce),
        removeSnapshotArtifacts(control.snapshots(), nonce)
    ]);
}

async function removeSnapshotArtifacts(
    directory: string,
    nonce: string,
    onlyTransient = false
): Promise<void> {
    const entries: Deno.DirEntry[] = [];
    try {
        for await (const entry of Deno.readDir(directory)) {
            entries.push(entry);
        }
    }
    catch (error) {
        if (!(error instanceof Error)) {
            throw error;
        }
        ignoreNotFound(error);
        return;
    }
    await Promise.all(
        entries
            .filter(
                (entry) =>
                    entry.isFile && entry.name.startsWith(nonce) &&
                    (!onlyTransient || entry.name.endsWith('.part'))
            )
            .map(async (entry) =>
                await Deno.remove(`${directory}/${entry.name}`, { recursive: false }).catch(ignoreNotFound)
            )
    );
}

function ignoreNotFound(error: Error): void {
    if (error instanceof Deno.errors.NotFound) {
        return;
    }
    throw error;
}

async function isSnapshotRequestPending(
    control: SnapshotControlDirectory,
    request: SnapshotRequest
): Promise<boolean> {
    const current = await readSnapshotRequest(`${control.requests()}/${request.nonce}.json`);
    return current?.nonce === request.nonce &&
        current.generation === request.generation &&
        current.requestedAtEpochMs === request.requestedAtEpochMs;
}

async function readSnapshotRequest(path: string): Promise<SnapshotRequest | undefined> {
    try {
        const value = JSON.parse(await Deno.readTextFile(path)) as Partial<SnapshotRequest>;
        const requestedAtEpochMs = value.requestedAtEpochMs;
        if (
            !isSnapshotToken(value.nonce) || !isSnapshotToken(value.generation) ||
            typeof requestedAtEpochMs !== 'number' || !Number.isFinite(requestedAtEpochMs)
        ) {
            throw new Error('Invalid private PGlite snapshot request.');
        }
        return {
            nonce: value.nonce,
            generation: value.generation,
            requestedAtEpochMs
        };
    }
    catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return undefined;
        }
        console.error('Ignoring invalid private PGlite snapshot request:', error);
        await Deno.remove(path).catch(ignoreNotFound);
        return undefined;
    }
}

async function publishResponse(
    control: SnapshotControlDirectory,
    response: SnapshotResponse,
    publicationHooks: SnapshotPublicationHooks | undefined
): Promise<void> {
    const destination = control.response(response.nonce);
    const temporary = `${destination}.${crypto.randomUUID()}.part`;
    await publicationHooks?.beforeResponseWrite?.(response);
    await Deno.writeTextFile(temporary, JSON.stringify(response), { mode: 0o600 });
    await publicationHooks?.beforeResponseRename?.(response);
    await Deno.rename(temporary, destination);
}

function isSnapshotToken(value: string | undefined): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]+$/u.test(value);
}
