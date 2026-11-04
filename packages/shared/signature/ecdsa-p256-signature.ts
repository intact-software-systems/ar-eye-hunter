import { isApiJsonObject, type ApiJsonObject, type ApiJsonValue } from '../api/api-json-value.ts';
import type { RallarValidationIssue } from '../api/rallar-validation.ts';
import { decodeBase64Url, isBase64UrlOfByteLength, toBase64Url } from '../encoding/base64url.ts';
import { serializeCanonicalJson } from '../encoding/canonical-json.ts';
import { Either } from '../resilience/Either.ts';
import { toError } from '../resilience/to-error.ts';

export interface EcdsaP256PublicJwk {
    readonly kty: 'EC';
    readonly crv: 'P-256';
    readonly x: string;
    readonly y: string;
}

export interface SigningKeyPair {
    readonly privateKey: CryptoKey;
    readonly publicJwk: EcdsaP256PublicJwk;
    /** The RFC 7638 thumbprint of `publicJwk`. */
    readonly keyId: string;
}

type SignatureFailureKind =
    | 'subtle-unavailable'
    | 'key-generation-failed'
    | 'invalid-key'
    | 'sign-failed'
    | 'invalid-signature';

/** Each operation names the kinds it can return, so a caller's failure map is total over them. */
export interface SignatureFailure<Kind extends SignatureFailureKind = SignatureFailureKind> {
    readonly kind: Kind;
    readonly message: string;
}

export interface VerifyDetachedInput {
    readonly subtle: SubtleCrypto;
    readonly publicKey: CryptoKey;
    readonly bytes: Uint8Array;
    readonly signature: string;
}

/** IEEE P1363 `r‖s`, the encoding WebCrypto signs and verifies. */
export const ECDSA_P256_SIGNATURE_BYTES = 64;
/** The RFC 7638 SHA-256 thumbprint that names a key. */
export const ECDSA_P256_KEY_ID_BYTES = 32;

const ECDSA_P256_KEY_ALGORITHM: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
const ECDSA_P256_SIGNATURE_ALGORITHM: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };
const ECDSA_P256_COORDINATE_BYTES = 32;
const ECDSA_P256_PUBLIC_JWK_KEYS: readonly string[] = ['kty', 'crv', 'x', 'y'];

export async function createSigningKeyPair(
    subtle: SubtleCrypto | undefined
): Promise<Either<SignatureFailure<'subtle-unavailable' | 'key-generation-failed'>, SigningKeyPair>> {
    if (subtle === undefined) {
        return Either.ofLeft({ kind: 'subtle-unavailable', message: 'WebCrypto SubtleCrypto is not available.' });
    }
    try {
        const keyPair = await subtle.generateKey(ECDSA_P256_KEY_ALGORITHM, false, ['sign', 'verify']);
        const exported = await subtle.exportKey('jwk', keyPair.publicKey);
        const publicJwk = decodeEcdsaP256PublicJwk({
            kty: exported.kty,
            crv: exported.crv,
            x: exported.x,
            y: exported.y
        });
        if (publicJwk.right === undefined) {
            return Either.ofLeft({
                kind: 'key-generation-failed',
                message: 'Generated public key is not a P-256 JWK.'
            });
        }
        const keyId = await computeEcdsaP256JwkThumbprint(subtle, publicJwk.right);
        return Either.ofRight({ privateKey: keyPair.privateKey, publicJwk: publicJwk.right, keyId });
    }
    catch (error) {
        return Either.ofLeft({
            kind: 'key-generation-failed',
            message: `Key generation was refused: ${toError(error).message}`
        });
    }
}

/** The base64url ECDSA P-256 / SHA-256 signature over `bytes`: 86 characters. */
export async function signDetached(
    subtle: SubtleCrypto,
    privateKey: CryptoKey,
    bytes: Uint8Array
): Promise<Either<SignatureFailure<'sign-failed'>, string>> {
    try {
        const signature = await subtle.sign(ECDSA_P256_SIGNATURE_ALGORITHM, privateKey, new Uint8Array(bytes));
        return Either.ofRight(toBase64Url(new Uint8Array(signature)));
    }
    catch (error) {
        return Either.ofLeft({ kind: 'sign-failed', message: `Signing was refused: ${toError(error).message}` });
    }
}

export async function verifyDetached(
    input: VerifyDetachedInput
): Promise<Either<SignatureFailure<'invalid-key' | 'invalid-signature'>, 'verified'>> {
    const signature = decodeBase64Url(input.signature).right;
    if (signature?.length !== ECDSA_P256_SIGNATURE_BYTES) {
        return Either.ofLeft({
            kind: 'invalid-signature',
            message: `Signature must be ${ECDSA_P256_SIGNATURE_BYTES} bytes of base64url text.`
        });
    }
    try {
        const verified = await input.subtle.verify(
            ECDSA_P256_SIGNATURE_ALGORITHM,
            input.publicKey,
            new Uint8Array(signature),
            new Uint8Array(input.bytes)
        );
        return verified
            ? Either.ofRight('verified')
            : Either.ofLeft({ kind: 'invalid-signature', message: 'Signature does not verify against the key.' });
    }
    catch (error) {
        return Either.ofLeft({
            kind: 'invalid-key',
            message: `Verification was refused: ${toError(error).message}`
        });
    }
}

export async function importEcdsaP256PublicKey(
    subtle: SubtleCrypto,
    jwk: EcdsaP256PublicJwk
): Promise<Either<SignatureFailure<'invalid-key'>, CryptoKey>> {
    try {
        const publicJwk: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
        return Either.ofRight(await subtle.importKey('jwk', publicJwk, ECDSA_P256_KEY_ALGORITHM, false, ['verify']));
    }
    catch (error) {
        return Either.ofLeft({
            kind: 'invalid-key',
            message: `Public key import was refused: ${toError(error).message}`
        });
    }
}

/** RFC 7638: SHA-256 over the required members in lexical order, in base64url (43 characters). */
export async function computeEcdsaP256JwkThumbprint(subtle: SubtleCrypto, jwk: EcdsaP256PublicJwk): Promise<string> {
    const thumbprintInput = serializeCanonicalJson({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
    return toBase64Url(new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(thumbprintInput))));
}

/** Exactly the four public members: a private member such as `d` is never accepted. */
export function decodeEcdsaP256PublicJwk(value: unknown): Either<readonly RallarValidationIssue[], EcdsaP256PublicJwk> {
    if (!isApiJsonObject(value)) {
        return Either.ofLeft([{ path: '$', code: 'invalid-record', message: 'Public JWK must be an object.' }]);
    }
    const issues = [...toPublicJwkKeyIssues(value), ...toPublicJwkMemberIssues(value)];
    return issues.length > 0
        ? Either.ofLeft(issues)
        : Either.ofRight({ kty: 'EC', crv: 'P-256', x: String(value.x), y: String(value.y) });
}

function toPublicJwkKeyIssues(jwk: ApiJsonObject): RallarValidationIssue[] {
    return [
        ...Object.keys(jwk)
            .filter((key) => !ECDSA_P256_PUBLIC_JWK_KEYS.includes(key))
            .map((key) => ({
                path: `$.${key}`,
                code: 'unexpected-key',
                message: `${key} is not a public JWK member.`
            })),
        ...ECDSA_P256_PUBLIC_JWK_KEYS
            .filter((key) => !Object.hasOwn(jwk, key))
            .map((key) => ({ path: `$.${key}`, code: 'missing-key', message: `${key} is required.` }))
    ];
}

function toPublicJwkMemberIssues(jwk: ApiJsonObject): RallarValidationIssue[] {
    return [
        ...(Object.hasOwn(jwk, 'kty') && jwk.kty !== 'EC'
            ? [{ path: '$.kty', code: 'invalid-kty', message: 'kty must be EC.' }]
            : []),
        ...(Object.hasOwn(jwk, 'crv') && jwk.crv !== 'P-256'
            ? [{ path: '$.crv', code: 'invalid-crv', message: 'crv must be P-256.' }]
            : []),
        ...(['x', 'y'] as const)
            .filter((key) => Object.hasOwn(jwk, key) && !isEcdsaP256Coordinate(jwk[key]))
            .map((key) => ({
                path: `$.${key}`,
                code: 'invalid-coordinate',
                message: `${key} must be ${ECDSA_P256_COORDINATE_BYTES} bytes of base64url text.`
            }))
    ];
}

function isEcdsaP256Coordinate(value: ApiJsonValue): boolean {
    return isBase64UrlOfByteLength(value, ECDSA_P256_COORDINATE_BYTES);
}
