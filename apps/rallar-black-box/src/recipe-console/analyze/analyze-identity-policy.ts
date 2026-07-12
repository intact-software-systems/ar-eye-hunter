export const ANALYZE_ARTIFACT_URL_ID_MAX_LENGTH = 256;

export type AnalyzeImportedArtifactIdentity = Readonly<{
    distributedRunId: string;
    controlRunId?: string;
}>;

export type AnalyzeSafeArtifactIdentity = Readonly<{
    distributedRunId?: string;
    controlRunId?: string;
}>;

const UNSAFE_ID_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

export function safeAnalyzeArtifactIdentity(
    identity: AnalyzeImportedArtifactIdentity,
): AnalyzeSafeArtifactIdentity {
    const distributedRunId = safeId(identity.distributedRunId);
    if (!distributedRunId) return {};
    const controlRunId = safeId(identity.controlRunId);
    return {
        distributedRunId,
        ...(controlRunId ? { controlRunId } : {}),
    };
}

export function analyzeArtifactIdentityIssues(
    identity: AnalyzeImportedArtifactIdentity,
): readonly string[] {
    return [
        identityIssue('distributed run ID', identity.distributedRunId),
        identityIssue('control run ID', identity.controlRunId),
    ].filter((issue): issue is string => issue !== undefined);
}

function safeId(value: string | undefined): string | undefined {
    if (
        value === undefined || value.length === 0 ||
        value.length > ANALYZE_ARTIFACT_URL_ID_MAX_LENGTH ||
        value.trim() !== value || UNSAFE_ID_CHARACTERS.test(value) ||
        hasLoneSurrogate(value)
    ) {
        return undefined;
    }
    return value;
}

function identityIssue(label: string, value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (value.length > ANALYZE_ARTIFACT_URL_ID_MAX_LENGTH) {
        return `The artifact ${label} exceeds ${ANALYZE_ARTIFACT_URL_ID_MAX_LENGTH} characters and was not copied into the URL.`;
    }
    if (
        value.length === 0 || value.trim() !== value ||
        UNSAFE_ID_CHARACTERS.test(value) || hasLoneSurrogate(value)
    ) {
        return `The artifact ${label} contains unsafe characters and was not copied into the URL.`;
    }
    return undefined;
}

function hasLoneSurrogate(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
            index += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return true;
        }
    }
    return false;
}
