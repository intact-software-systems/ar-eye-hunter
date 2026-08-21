export type AnalyzeControlIdentityDigest = Readonly<{
    distributedRunIdSha256: string;
    controlRunIdSha256?: string;
}>;

const SHA_256_HEX = /^[a-f0-9]{64}$/u;

export async function createAnalyzeControlIdentityDigest(
    identity: Readonly<{
        distributedRunId: string;
        controlRunId?: string;
    }>
): Promise<AnalyzeControlIdentityDigest> {
    return {
        distributedRunIdSha256: await sha256(identity.distributedRunId),
        ...(identity.controlRunId === undefined
            ? {}
            : { controlRunIdSha256: await sha256(identity.controlRunId) })
    };
}

export function isAnalyzeControlIdentityDigest(
    value: unknown
): value is AnalyzeControlIdentityDigest {
    if (
        !isRecord(value) ||
        Object.keys(value).some((key) => key !== 'distributedRunIdSha256' && key !== 'controlRunIdSha256') ||
        typeof value.distributedRunIdSha256 !== 'string' ||
        !SHA_256_HEX.test(value.distributedRunIdSha256)
    ) {
        return false;
    }
    return value.controlRunIdSha256 === undefined ||
        (typeof value.controlRunIdSha256 === 'string' &&
            SHA_256_HEX.test(value.controlRunIdSha256));
}

export async function analyzeControlIdentityMatchesDigest(
    identity: Readonly<{ distributedRunId: string; controlRunId?: string; }>,
    expected: AnalyzeControlIdentityDigest
): Promise<boolean> {
    const actual = await createAnalyzeControlIdentityDigest(identity);
    return actual.distributedRunIdSha256 === expected.distributedRunIdSha256 &&
        (expected.controlRunIdSha256 === undefined ||
            actual.controlRunIdSha256 === expected.controlRunIdSha256);
}

async function sha256(value: string): Promise<string> {
    const digest = new Uint8Array(
        await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(value)
        )
    );
    return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
