import { decodeBase64Url } from '../../encoding/base64url.ts';
import { Either } from '../../resilience/Either.ts';
import { decodeEcdsaP256PublicJwk, ECDSA_P256_KEY_ID_BYTES } from '../../signature/ecdsa-p256-signature.ts';
import type { ApiJsonObject, ApiJsonValue } from '../api-json-value.ts';
import type { GroupPresencePublicationKey } from '../group-types.ts';
import type { RallarValidationIssue } from '../rallar-validation.ts';

const PUBLICATION_KEY_KEYS: readonly string[] = ['keyId', 'publicJwk'];

/**
 * The one publication-key decoder for the presence request, the stored row, the snapshot and the delta: exactly a
 * 43-character key id and a public P-256 JWK, or `null`. Shape only — receivers recompute the thumbprint.
 */
export function decodeGroupPresencePublicationKey(
    value: unknown
): Either<readonly RallarValidationIssue[], GroupPresencePublicationKey | null> {
    if (value === undefined) {
        return Either.ofLeft([{ path: '$', code: 'missing-publication-key', message: 'publicationKey is required.' }]);
    }
    if (value === null) {
        return Either.ofRight(null);
    }
    if (typeof value !== 'object' || !isApiJsonObject(value)) {
        return Either.ofLeft([{ path: '$', code: 'invalid-record', message: 'publicationKey must be an object.' }]);
    }
    const publicJwk = Object.hasOwn(value, 'publicJwk') ? decodeEcdsaP256PublicJwk(value.publicJwk) : undefined;
    const issues = [
        ...toPublicationKeyMemberIssues(value),
        ...toPublicationKeyIdIssues(value),
        ...(publicJwk?.left ?? []).map((issue) => ({ ...issue, path: issue.path.replace(/^\$/, '$.publicJwk') }))
    ];
    return issues.length > 0 || publicJwk?.right === undefined
        ? Either.ofLeft(issues)
        : Either.ofRight({ keyId: String(value.keyId), publicJwk: publicJwk.right });
}

function isApiJsonObject(value: object): value is ApiJsonObject {
    return !Array.isArray(value);
}

function toPublicationKeyMemberIssues(key: ApiJsonObject): RallarValidationIssue[] {
    return [
        ...Object.keys(key)
            .filter((member) => !PUBLICATION_KEY_KEYS.includes(member))
            .map((member) => ({
                path: `$.${member}`,
                code: 'unexpected-key',
                message: `${member} is not a publication key member.`
            })),
        ...PUBLICATION_KEY_KEYS
            .filter((member) => !Object.hasOwn(key, member))
            .map((member) => ({ path: `$.${member}`, code: 'missing-key', message: `${member} is required.` }))
    ];
}

function toPublicationKeyIdIssues(key: ApiJsonObject): RallarValidationIssue[] {
    return Object.hasOwn(key, 'keyId') && !isPublicationKeyId(key.keyId)
        ? [{
            path: '$.keyId',
            code: 'invalid-key-id',
            message: `keyId must be ${ECDSA_P256_KEY_ID_BYTES} bytes of base64url text.`
        }]
        : [];
}

function isPublicationKeyId(value: ApiJsonValue): boolean {
    return typeof value === 'string' && decodeBase64Url(value).right?.length === ECDSA_P256_KEY_ID_BYTES;
}
