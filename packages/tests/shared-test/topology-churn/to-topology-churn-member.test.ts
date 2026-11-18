import { toTopologyChurnMember } from '@shared-test/black-box-runner/topology-churn/to-topology-churn-member.ts';
import { describe, expect, it } from 'vitest';

const API_BASE_URLS = ['http://127.0.0.1:18880', 'http://127.0.0.1:18881', 'http://127.0.0.1:18882'];

describe('toTopologyChurnMember', () => {
    it('names the member by run, room and index and spreads members over the API processes', () => {
        const members = [0, 1, 2, 3].map((memberIndex) =>
            toTopologyChurnMember({ runToken: 'run12345', roomIndex: 4, memberIndex, apiBaseUrls: API_BASE_URLS })
        );

        expect(members.map((member) => member.username)).toEqual([
            'churn-run12345-4-0',
            'churn-run12345-4-1',
            'churn-run12345-4-2',
            'churn-run12345-4-3'
        ]);
        expect(members.map((member) => member.apiBaseUrl)).toEqual([...API_BASE_URLS, API_BASE_URLS[0]]);
    });

    it('gives every member index its own client address', () => {
        const addresses = [0, 1, 249, 250, 251, 499, 500].map((memberIndex) =>
            toTopologyChurnMember({ runToken: 'run', roomIndex: 0, memberIndex, apiBaseUrls: API_BASE_URLS }).clientIp
        );

        expect(addresses).toEqual(['10.1.0.1', '10.1.0.2', '10.1.0.250', '10.2.0.1', '10.2.0.2', '10.2.0.250', '10.3.0.1']);
    });
});
