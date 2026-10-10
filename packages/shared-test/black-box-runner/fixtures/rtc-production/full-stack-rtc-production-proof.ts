export interface FullStackRtcProductionAttemptIdentity {
    readonly workloadId: string;
    readonly caseId: string;
    readonly inputKey: string;
    readonly environmentId: string;
    readonly intendedPhase: 'warmup' | 'retained';
    readonly outerOrdinal: number;
    readonly rawResultRelativePath: string;
}
export interface FullStackRtcProductionGit {
    readonly headCommit: string;
    readonly headTree: string;
    readonly ref: string;
    readonly clean: boolean;
}
export interface FullStackRtcProductionInput {
    readonly path: string;
    readonly kind: 'source' | 'config';
    readonly sha256: string;
}
export interface FullStackRtcProductionBinding {
    readonly baselineId: string;
    readonly attempt: FullStackRtcProductionAttemptIdentity;
    readonly git: FullStackRtcProductionGit;
    readonly inputFiles: readonly FullStackRtcProductionInput[];
}
export interface FullStackRtcProductionFile {
    readonly path: string;
    readonly sizeBytes: number;
    readonly sha256: string;
}

export interface FullStackRtcProductionSeal {
    readonly version: 1;
    readonly appServingMode: 'production';
    readonly viteMode: 'production';
    readonly nodeEnvironment: 'production';
    readonly buildTarget: 'es2023';
    readonly baselineId: string;
    readonly attempt: FullStackRtcProductionAttemptIdentity;
    readonly buildRoot: string;
    readonly apiOrigin: string;
    readonly spaOrigin: string;
    readonly git: FullStackRtcProductionGit;
    readonly inputFiles: readonly FullStackRtcProductionInput[];
    readonly files: readonly FullStackRtcProductionFile[];
    readonly entryFiles: readonly string[];
    readonly buildArguments: readonly string[];
}

export interface FullStackRtcServedBuild {
    readonly seal: FullStackRtcProductionSeal;
    readonly servedFiles: readonly FullStackRtcProductionFile[];
}

export interface FullStackRtcBrowserEntry extends FullStackRtcProductionFile {
    readonly prefix: 'A' | 'B' | 'C';
}

export interface FullStackRtcServingProof {
    readonly build: FullStackRtcServedBuild;
    readonly entries: readonly FullStackRtcBrowserEntry[];
}

export const FULL_STACK_RTC_PRODUCTION_POLICY = {
    appServingMode: 'production',
    viteMode: 'production',
    nodeEnvironment: 'production',
    buildTarget: 'es2023'
} as const;
const fileKeys = ['path', 'sizeBytes', 'sha256'];
const sealKeys = [
    'version',
    ...Object.keys(FULL_STACK_RTC_PRODUCTION_POLICY),
    'baselineId',
    'attempt',
    'buildRoot',
    'apiOrigin',
    'spaOrigin',
    'git',
    'inputFiles',
    'files',
    'entryFiles',
    'buildArguments'
];

export function validateFullStackRtcProductionProof(
    raw: unknown,
    binding: FullStackRtcProductionBinding
): readonly string[] {
    const proof = toRecord(raw);
    const build = toRecord(proof?.build);
    const seal = toRecord(build?.seal);
    const issues = validateProductionProofBinding(binding, seal);
    if (
        !proof || !build || !seal || Object.keys(proof).some((key) => !['build', 'entries'].includes(key)) ||
        Object.keys(build).some((key) => !['seal', 'servedFiles'].includes(key))
    ) {
        issues.push('missing-proof');
    }
    return seal && build && proof ? [...issues, ...validateProductionProofFiles(seal, build, proof)] : issues;
}
function validateProductionProofBinding(
    binding: FullStackRtcProductionBinding,
    seal: Record<string, unknown> | null
): string[] {
    if (!seal) {
        return ['missing-seal'];
    }
    const issues: string[] = [];
    if (
        seal.version !== 1 ||
        Object.entries(FULL_STACK_RTC_PRODUCTION_POLICY).some(([field, expected]) => seal[field] !== expected) ||
        Object.keys(seal).some((key) => !sealKeys.includes(key))
    ) {
        issues.push('mode-or-shape');
    }
    issues.push(...validateProductionProofAttempt(binding, seal));
    if (
        JSON.stringify(seal.git) !== JSON.stringify(binding.git) ||
        JSON.stringify(seal.inputFiles) !== JSON.stringify(binding.inputFiles)
    ) {
        issues.push('input-provenance');
    }
    const baselineId = binding.baselineId;
    if (
        seal.baselineId !== baselineId || typeof seal.buildRoot !== 'string' ||
        !seal.buildRoot.endsWith(
            `/tmp/perf/rtc-b06-private-build/${baselineId}/${binding.attempt.caseId}/${binding.attempt.intendedPhase}-${binding.attempt.outerOrdinal}`
        )
    ) {
        issues.push('output-owner');
    }
    for (const field of ['apiOrigin', 'spaOrigin']) {
        if (!isSafeOrigin(seal[field])) {
            issues.push('origin');
        }
    }
    const expectedArguments = [
        '--workspace',
        'rallar-black-box',
        'run',
        'build',
        '--',
        '--outDir',
        `${seal.buildRoot}/output`,
        '--emptyOutDir',
        '--mode',
        'production',
        '--target',
        'es2023'
    ];
    if (JSON.stringify(seal.buildArguments) !== JSON.stringify(expectedArguments)) {
        issues.push('build-command');
    }
    return issues;
}

function validateProductionProofAttempt(
    binding: FullStackRtcProductionBinding,
    seal: Record<string, unknown>
): string[] {
    const attempt = toRecord(seal.attempt);
    const fields = Object.keys(binding.attempt) as (keyof FullStackRtcProductionAttemptIdentity)[];
    return !attempt || Object.keys(attempt).length !== fields.length ||
            fields.some((field) => attempt[field] !== binding.attempt[field]) ||
            attempt.environmentId !== 'E3-memory'
        ? ['attempt']
        : [];
}

function validateProductionProofFiles(
    seal: Record<string, unknown>,
    build: Record<string, unknown>,
    proof: Record<string, unknown>
): string[] {
    const issues: string[] = [];
    const files = toFiles(seal.files);
    const served = toFiles(build.servedFiles);
    if (
        !files || !served || !files.some((file) => file.path === '.vite/manifest.json') ||
        !files.some((file) => file.path === 'index.html')
    ) {
        return ['file-inventory'];
    }
    const expectedServed = files.filter((file) => !String(file.path).startsWith('.'));
    if (JSON.stringify(served) !== JSON.stringify(expectedServed)) {
        issues.push('served-bytes');
    }
    const entryFiles = seal.entryFiles;
    if (
        !Array.isArray(entryFiles) || entryFiles.length === 0 ||
        entryFiles.some((path) => typeof path !== 'string' || !files.some((file) => file.path === path))
    ) {
        return [...issues, 'entry-manifest'];
    }
    if (!Array.isArray(proof.entries)) {
        return [...issues, 'browser-entries'];
    }
    const entries = proof.entries.map(toRecord);
    for (const entry of entries) {
        const file = entry && served.find((file) => file.path === entry.path);
        if (
            !entry || !file || Object.keys(entry).some((key) => !['prefix', ...fileKeys].includes(key)) ||
            !['A', 'B', 'C'].includes(String(entry.prefix)) || fileKeys.some((key) => entry[key] !== file[key])
        ) {
            issues.push('browser-bytes');
        }
    }
    for (const prefix of ['A', 'B', 'C']) {
        for (const path of ['index.html', ...entryFiles]) {
            if (!entries.some((entry) => entry?.prefix === prefix && entry.path === path)) {
                issues.push('browser-entry-missing');
            }
        }
    }
    return issues;
}

function toFiles(raw: unknown | undefined): Record<string, unknown>[] | null {
    if (!Array.isArray(raw)) {
        return null;
    }
    const files = raw.map(toRecord);
    const paths = new Set<unknown>();
    for (const file of files) {
        if (
            !file || Object.keys(file).some((key) => !fileKeys.includes(key)) || typeof file.path !== 'string' ||
            !/^[a-zA-Z0-9._/-]+$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').includes('..') ||
            typeof file.sizeBytes !== 'number' || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 ||
            typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || paths.has(file.path)
        ) {
            return null;
        }
        paths.add(file.path);
    }
    return files as Record<string, unknown>[];
}

function isSafeOrigin(value: unknown | undefined): boolean {
    if (typeof value !== 'string') {
        return false;
    }
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search &&
            !url.hash && value === url.origin;
    }
    catch {
        return false;
    }
}

function toRecord(raw: unknown | undefined): Record<string, unknown> | null {
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

export function decodeProductionSeal(raw: unknown): FullStackRtcProductionSeal | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const value = raw as Record<string, unknown>;
    if (
        value.version !== 1 ||
        Object.entries(FULL_STACK_RTC_PRODUCTION_POLICY).some(([field, expected]) => value[field] !== expected) ||
        typeof value.baselineId !== 'string' || typeof value.buildRoot !== 'string' ||
        typeof value.apiOrigin !== 'string' || typeof value.spaOrigin !== 'string' ||
        !value.attempt || typeof value.attempt !== 'object' || !value.git || typeof value.git !== 'object' ||
        !Array.isArray(value.inputFiles) ||
        !Array.isArray(value.files) ||
        value.files.some((file) =>
            !file || typeof file.path !== 'string' || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 ||
            !/^[a-f0-9]{64}$/.test(file.sha256)
        ) ||
        !Array.isArray(value.entryFiles) || value.entryFiles.some((file) => typeof file !== 'string') ||
        !Array.isArray(value.buildArguments) || value.buildArguments.some((argument) => typeof argument !== 'string')
    ) {
        return null;
    }
    const allowed = [
        'version',
        ...Object.keys(FULL_STACK_RTC_PRODUCTION_POLICY),
        'baselineId',
        'attempt',
        'buildRoot',
        'apiOrigin',
        'spaOrigin',
        'git',
        'inputFiles',
        'files',
        'entryFiles',
        'buildArguments'
    ];
    if (Object.keys(value).some((key) => !allowed.includes(key))) {
        return null;
    }
    return raw as FullStackRtcProductionSeal;
}
