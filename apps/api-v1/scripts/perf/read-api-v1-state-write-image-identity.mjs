import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PINNED_IMAGE = 'postgres@sha256:081f1bc7bd5e143dbb6e487b710bbc27712cdcfaced4c071b8e47349aa1b4171';
const MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const CONFIG_MEDIA_TYPE = 'application/vnd.oci.image.config.v1+json';
const METADATA_LIMIT = 65_536;

// Docker's containerd Id is an index/manifest target, while the governed field
// denotes original configuration bytes. This owner binds those representations
// through the actual container and a local export, never an expected-ID lookup.
export async function readApiV1StateWriteImageIdentity({ container, directory }) {
    await mkdir(dirname(directory), { recursive: true });
    await mkdir(directory, { mode: 0o700 });
    const containerInspection = await writeAcquisitionMetadata({
        directory,
        name: 'container-inspect.json',
        bytes: container.inspectionBytes
    });
    const { stdout } = await execFileAsync(
        'docker',
        ['image', 'inspect', container.imageId, '--format', '{{json .}}'],
        { timeout: 15_000, maxBuffer: METADATA_LIMIT, encoding: 'buffer' }
    );
    const imageInspection = await writeAcquisitionMetadata({ directory, name: 'image-inspect.json', bytes: stdout });
    const nativeImage = toNativeImage({ text: stdout.toString('utf8'), container });
    const acquisitionStarted = performance.now();
    const archive = join(directory, 'image.tar');
    await readImageArchive({ archive, nativeImage });
    const names = await readArchiveNames({ archive });
    const identity = container.manifest === undefined
        ? await readClassicConfiguration({ archive, names, nativeImage, directory })
        : await readContainerConfiguration({ archive, names, nativeImage, directory, manifest: container.manifest });
    const archiveArtifact = await readAcquisitionArchive({ path: archive });
    return {
        record: {
            image_ref: PINNED_IMAGE,
            repo_digest: PINNED_IMAGE,
            image_id: identity.digest,
            image_architecture: nativeImage.architecture,
            image_os: nativeImage.os,
            entrypoint: nativeImage.entrypoint
        },
        proof: {
            containerImageId: container.imageId,
            nativeImageId: nativeImage.id,
            nativeRepoDigests: nativeImage.repoDigests,
            archiveBytes: archiveArtifact.bytes,
            metadataAcquisitionMs: performance.now() - acquisitionStarted,
            ...identity.proof,
            acquisition: {
                directory,
                artifacts: { archive: archiveArtifact, containerInspection, imageInspection, ...identity.artifacts }
            }
        }
    };
}

async function readImageArchive({ archive, nativeImage }) {
    await execFileAsync('docker', [
        'image',
        'save',
        '--platform',
        `${nativeImage.os}/${nativeImage.architecture}`,
        '--output',
        archive,
        PINNED_IMAGE
    ], { timeout: 120_000, maxBuffer: METADATA_LIMIT });
}

async function writeAcquisitionMetadata({ directory, name, bytes }) {
    const path = join(directory, name);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function readAcquisitionArchive({ path }) {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(path)) {
        bytes += chunk.length;
        hash.update(chunk);
    }
    return { path, bytes, sha256: hash.digest('hex') };
}

function toNativeImage({ text, container }) {
    const inspected = toNativeObject({ value: JSON.parse(text) });
    const id = toNativeString({ value: inspected.Id });
    const architecture = toNativeString({ value: inspected.Architecture });
    const os = toNativeString({ value: inspected.Os });
    const config = toNativeObject({ value: inspected.Config });
    const repoDigests = toNativeStrings({ value: inspected.RepoDigests });
    const entrypoints = toNativeStrings({ value: config.Entrypoint });
    if (
        id !== container.imageId || repoDigests.filter((digest) => digest === PINNED_IMAGE).length !== 1 ||
        entrypoints.length !== 1
    ) {
        throw new TypeError('container image must bind the exact pinned native repository identity');
    }
    if (container.manifest === undefined && inspected.Descriptor != null) {
        throw new TypeError('multi-platform image requires the actual container manifest descriptor');
    }
    if (container.manifest !== undefined) {
        const descriptor = toNativeObject({ value: inspected.Descriptor });
        if (
            descriptor.digest !== id || descriptor.mediaType !== 'application/vnd.oci.image.index.v1+json' ||
            container.manifest.platform.os !== os || container.manifest.platform.architecture !== architecture
        ) {
            throw new TypeError('native image and actual container manifest must agree');
        }
    }
    return { id, architecture, os, repoDigests, entrypoint: entrypoints[0] };
}

/** @param {{ value: unknown }} input */
export function toImageManifestDescriptor({ value }) {
    if (value === undefined || value === null) {
        return undefined;
    }
    const descriptor = toContentDescriptor({ value, mediaType: MANIFEST_MEDIA_TYPE });
    const platform = toNativeObject({ value: toNativeObject({ value }).platform });
    const os = toNativeString({ value: platform.os });
    const architecture = toNativeString({ value: platform.architecture });
    if (platform.variant !== undefined && typeof platform.variant !== 'string') {
        throw new TypeError('image manifest variant must be text');
    }
    return { ...descriptor, platform: { os, architecture, variant: platform.variant } };
}

async function readContainerConfiguration({ archive, names, nativeImage, manifest, directory }) {
    const indexBytes = await readArchiveMetadata({ archive, names, name: 'index.json' });
    const exportIndex = await writeAcquisitionMetadata({ directory, name: 'export-index.json', bytes: indexBytes });
    const index = toNativeObject({ value: JSON.parse(indexBytes.toString('utf8')) });
    if (
        index.schemaVersion !== 2 || index.mediaType !== 'application/vnd.oci.image.index.v1+json' ||
        !Array.isArray(index.manifests)
    ) {
        throw new TypeError('export index must contain OCI manifest descriptors');
    }
    const matches = index.manifests.map((value) => toNativeObject({ value })).filter((descriptor) =>
        descriptor.platform !== undefined
    ).map((value) => toImageManifestDescriptor({ value })).filter((descriptor) =>
        descriptor.platform.os === manifest.platform.os &&
        descriptor.platform.architecture === manifest.platform.architecture &&
        descriptor.platform.variant === manifest.platform.variant
    );
    if (matches.length !== 1 || matches[0].digest !== manifest.digest || matches[0].size !== manifest.size) {
        throw new TypeError('export must identify exactly the actual container selected manifest');
    }
    const manifestBytes = await readArchiveMetadata({
        archive,
        names,
        name: `blobs/sha256/${manifest.digest.slice(7)}`
    });
    const selectedManifest = await writeAcquisitionMetadata({
        directory,
        name: 'selected-manifest.json',
        bytes: manifestBytes
    });
    const originalManifest = toNativeObject({
        value: JSON.parse(toContentBytes({ bytes: manifestBytes, descriptor: manifest }).toString('utf8'))
    });
    if (originalManifest.mediaType !== MANIFEST_MEDIA_TYPE || originalManifest.schemaVersion !== 2) {
        throw new TypeError('original selected manifest must be OCI image metadata');
    }
    const config = toContentDescriptor({ value: originalManifest.config, mediaType: CONFIG_MEDIA_TYPE });
    const configBytes = await readArchiveMetadata({ archive, names, name: `blobs/sha256/${config.digest.slice(7)}` });
    const configuration = await writeAcquisitionMetadata({ directory, name: 'config.json', bytes: configBytes });
    const digest = toConfigurationIdentity({
        bytes: toContentBytes({ bytes: configBytes, descriptor: config }),
        nativeImage
    });
    return {
        digest,
        artifacts: { exportIndex, selectedManifest, configuration },
        proof: {
            store: 'containerd',
            containerManifest: manifest,
            exportIndexDigest: toBytesDigest({ bytes: indexBytes }),
            manifestDigest: toBytesDigest({ bytes: manifestBytes }),
            configBytes: configBytes.length
        }
    };
}

async function readClassicConfiguration({ archive, names, nativeImage, directory }) {
    const metadataBytes = await readArchiveMetadata({ archive, names, name: 'manifest.json' });
    const exportMetadata = await writeAcquisitionMetadata({
        directory,
        name: 'export-metadata.json',
        bytes: metadataBytes
    });
    const metadata = JSON.parse(metadataBytes.toString('utf8'));
    if (!Array.isArray(metadata) || metadata.length !== 1) {
        throw new TypeError('classic export must identify exactly one configuration');
    }
    const configName = toNativeString({ value: toNativeObject({ value: metadata[0] }).Config });
    const configBytes = await readArchiveMetadata({ archive, names, name: configName });
    const configuration = await writeAcquisitionMetadata({ directory, name: 'config.json', bytes: configBytes });
    const digest = toConfigurationIdentity({ bytes: configBytes, nativeImage });
    if (digest !== nativeImage.id) {
        throw new TypeError('classic configuration bytes must match the native container image identity');
    }
    return {
        digest,
        artifacts: { exportMetadata, configuration },
        proof: { store: 'classic', configBytes: configBytes.length }
    };
}

async function readArchiveNames({ archive }) {
    const { stdout } = await execFileAsync('tar', ['-tf', archive], { timeout: 15_000, maxBuffer: 1_048_576 });
    const names = stdout.trimEnd().split('\n');
    if (
        new Set(names).size !== names.length ||
        names.some((name) => !/^[a-zA-Z0-9._/-]+$/.test(name) || name.startsWith('/') || name.split('/').includes('..'))
    ) {
        throw new TypeError('image archive names must be safe and unambiguous');
    }
    return names;
}

async function readArchiveMetadata({ archive, names, name }) {
    if (
        !names.includes(name) || !/^[a-zA-Z0-9._/-]+$/.test(name) || name.startsWith('/') ||
        name.split('/').includes('..')
    ) {
        throw new TypeError('image archive is missing named identity metadata');
    }
    const kind = await execFileAsync('tar', ['-tvf', archive, '--', name], {
        timeout: 15_000,
        maxBuffer: METADATA_LIMIT
    });
    if (!kind.stdout.startsWith('-') || kind.stdout.trimEnd().split('\n').length !== 1) {
        throw new TypeError('image identity metadata must be one regular archive file');
    }
    const { stdout } = await execFileAsync('tar', ['-xOf', archive, '--', name], {
        timeout: 15_000,
        maxBuffer: METADATA_LIMIT,
        encoding: 'buffer'
    });
    if (stdout.length === 0) {
        throw new TypeError('image identity metadata must not be empty');
    }
    return stdout;
}

function toContentBytes({ bytes, descriptor }) {
    if (bytes.length !== descriptor.size || toBytesDigest({ bytes }) !== descriptor.digest) {
        throw new TypeError('image identity metadata bytes do not match their descriptor');
    }
    return bytes;
}

function toConfigurationIdentity({ bytes, nativeImage }) {
    const config = toNativeObject({ value: JSON.parse(bytes.toString('utf8')) });
    if (config.os !== nativeImage.os || config.architecture !== nativeImage.architecture) {
        throw new TypeError('configuration bytes must declare the native selected platform');
    }
    return toBytesDigest({ bytes });
}

function toContentDescriptor({ value, mediaType }) {
    const descriptor = toNativeObject({ value });
    if (
        descriptor.mediaType !== mediaType || typeof descriptor.digest !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(descriptor.digest) || typeof descriptor.size !== 'number' ||
        !Number.isSafeInteger(descriptor.size) || descriptor.size <= 0 || descriptor.size > METADATA_LIMIT
    ) {
        throw new TypeError('image content descriptor must identify bounded SHA256 metadata');
    }
    return { mediaType, digest: descriptor.digest, size: descriptor.size };
}

function toBytesDigest({ bytes }) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** @param {{ value: unknown }} input */
function toNativeObject({ value }) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('native image metadata must be an object');
    }
    return /** @type {Record<string, unknown>} */ (value);
}

/** @param {{ value: unknown }} input */
function toNativeString({ value }) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError('native image metadata must contain nonempty text');
    }
    return value;
}

/** @param {{ value: unknown }} input */
function toNativeStrings({ value }) {
    if (!Array.isArray(value)) {
        throw new TypeError('native image metadata must contain an array of nonempty text');
    }
    return value.map((entry) => toNativeString({ value: entry }));
}
