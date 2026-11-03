import type { RallarValidationIssue } from '../api/rallar-validation.ts';
import { Either } from '../resilience/Either.ts';

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_TEXT = /^[A-Za-z0-9_-]*$/u;
const BASE64_ANY_TEXT = /^(?<digits>[A-Za-z0-9+/_-]*)(?<padding>={0,2})$/u;

/** Unpadded RFC 4648 §5 text. */
export function toBase64Url(bytes: Uint8Array): string {
    let text = '';
    for (let index = 0; index < bytes.length; index += 3) {
        const group = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
        const digitCount = Math.min(bytes.length - index, 3) + 1;
        for (let digit = 0; digit < digitCount; digit += 1) {
            text += BASE64URL_ALPHABET[(group >> (18 - 6 * digit)) & 63];
        }
    }
    return text;
}

/**
 * Strict: the URL-safe alphabet only, no padding, never a length that cannot encode whole bytes, and only the
 * canonical text of its bytes (RFC 4648 §3.5: the unused trailing bits are zero), so one byte string has one text.
 */
export function decodeBase64Url(text: string): Either<readonly RallarValidationIssue[], Uint8Array> {
    if (!BASE64URL_TEXT.test(text) || text.length % 4 === 1 || !hasZeroTrailingBits(text)) {
        return Either.ofLeft([
            { path: '$', code: 'invalid-base64url', message: 'Value must be unpadded base64url text.' }
        ]);
    }
    return Either.ofRight(toBytesFromBase64UrlDigits(text));
}

/** Lenient: the standard or the URL-safe alphabet, unpadded or padded to a whole four-digit group. */
export function decodeBase64Any(text: string): Either<readonly RallarValidationIssue[], Uint8Array> {
    const digits = BASE64_ANY_TEXT.exec(text)?.groups?.digits;
    const padded = digits !== undefined && digits.length < text.length;
    if (digits === undefined || digits.length % 4 === 1 || (padded && text.length % 4 !== 0)) {
        return Either.ofLeft([
            { path: '$', code: 'invalid-base64', message: 'Value must be base64 or base64url text.' }
        ]);
    }
    return Either.ofRight(toBytesFromBase64UrlDigits(digits.replaceAll('+', '-').replaceAll('/', '_')));
}

function hasZeroTrailingBits(digits: string): boolean {
    const unusedBitMask = [0, 0, 0b1111, 0b11][digits.length % 4] ?? 0;
    return (BASE64URL_ALPHABET.indexOf(digits.at(-1) ?? 'A') & unusedBitMask) === 0;
}

function toBytesFromBase64UrlDigits(digits: string): Uint8Array {
    const bytes = new Uint8Array(Math.floor(digits.length * 3 / 4));
    let pending = 0;
    let pendingBits = 0;
    let offset = 0;
    for (const digit of digits) {
        pending = ((pending << 6) | BASE64URL_ALPHABET.indexOf(digit)) & 0xfff;
        pendingBits += 6;
        if (pendingBits >= 8) {
            pendingBits -= 8;
            bytes[offset] = (pending >> pendingBits) & 255;
            offset += 1;
        }
    }
    return bytes;
}
