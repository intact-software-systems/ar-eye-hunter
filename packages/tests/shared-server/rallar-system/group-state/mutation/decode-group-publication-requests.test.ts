import {
    decodeGrantGroupPublicationRequest,
    decodeRevokeGroupPublicationRequest
} from '@shared-server/rallar-system/group-state/mutation/publication/decode-group-publication-requests.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { describe, expect, it } from 'vitest';

const REQUEST = { requestId: 'pubgrant-decode-request', topicId: 'room.feed', publish: true, subscribe: false };
const DECODERS = [decodeGrantGroupPublicationRequest, decodeRevokeGroupPublicationRequest] as const;

function toIssueCodes(value: ApiJsonValue, decoder: (typeof DECODERS)[number]): readonly string[] {
    return decoder(value).fold((issues) => issues.map((issue) => issue.code), () => []);
}

describe('group publication request decoding', () => {
    it('decodes the named permissions and drops the body actor the route replaces', () => {
        for (const decoder of DECODERS) {
            const decoded = decoder({
                ...REQUEST,
                reason: 'feed host',
                actorPrincipalId: 'forged-actor',
                actorSessionId: 'forged-session'
            });

            expect(decoded.right).toEqual({ ...REQUEST, reason: 'feed host' });
        }
    });

    it('refuses a request that names neither permission', () => {
        for (const decoder of DECODERS) {
            expect(toIssueCodes({ ...REQUEST, publish: false }, decoder)).toEqual(['empty-permissions']);
        }
    });

    it('refuses reserved, prefix-less and non-string topic ids', () => {
        for (const decoder of DECODERS) {
            expect(toIssueCodes({ ...REQUEST, topicId: 'rallar.state' }, decoder)).toEqual(['reserved-ws-topic']);
            expect(toIssueCodes({ ...REQUEST, topicId: 'feed' }, decoder)).toEqual(['invalid-ws-user-topic']);
            expect(toIssueCodes({ ...REQUEST, topicId: 7 }, decoder)).toEqual(['invalid-type']);
        }
    });

    it('refuses an extra key, a missing permission, a non-boolean permission and a blank reason', () => {
        const { subscribe: _subscribe, ...withoutSubscribe } = REQUEST;
        for (const decoder of DECODERS) {
            expect(toIssueCodes({ ...REQUEST, role: 'admin' }, decoder)).toEqual(['unknown-key']);
            expect(toIssueCodes(withoutSubscribe, decoder)).toContain('missing-key');
            expect(toIssueCodes({ ...REQUEST, publish: 'yes' }, decoder)).toEqual(['invalid-boolean']);
            expect(toIssueCodes({ ...REQUEST, reason: '' }, decoder)).toEqual(['invalid-string']);
        }
    });

    it('refuses a body that is not an object', () => {
        for (const decoder of DECODERS) {
            for (const value of [null, [], 'room.feed']) {
                expect(toIssueCodes(value, decoder)).toEqual(['invalid-record']);
            }
        }
    });
});
