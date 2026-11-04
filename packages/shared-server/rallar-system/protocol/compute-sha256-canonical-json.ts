import { createHash } from 'node:crypto';

import { serializeCanonicalJson, type CanonicalJsonInput } from '@shared/encoding/canonical-json.ts';

export function computeSha256CanonicalJson(value: CanonicalJsonInput): string {
    return createHash('sha256').update(serializeCanonicalJson(value), 'utf8').digest('hex');
}
