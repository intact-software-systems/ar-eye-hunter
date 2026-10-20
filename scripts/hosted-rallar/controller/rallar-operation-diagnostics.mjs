import { stripVTControlCharacters } from 'node:util';

// Shared by the controller error boundary and the operation report before evidence is persisted.
export function sanitizeOperationLog(value, privateValues = []) {
    let sanitized = stripVTControlCharacters(value);
    for (const privateValue of privateValues) {
        if (privateValue) {
            sanitized = sanitized.split(privateValue).join('[REDACTED]');
        }
    }
    return sanitized
        .replace(/(authorization\s*:\s*bearer)\s+[^\s]+/gi, '$1 [REDACTED]')
        .replace(/((?:password|token|secret)[a-z0-9_]*\s*=)\s*(?:"[^"]*"|'[^']*'|[^\s]*)/gi, '$1[REDACTED]')
        .replace(/([?&](?:token|password|secret)=)[^&\s]*/gi, '$1[REDACTED]')
        .replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}
