import { describe, expect, it } from 'vitest';

import { computeDirectWriteFindings } from '../../../../scripts/direct-write-check/compute-direct-write-findings.mjs';

const BASIS = 'Read the opener and its worker trigger in the named file.';

describe('direct-write findings', () => {
    it('reports nothing when every fact has its entry with the same attributes', () => {
        const facts = { transactionOpeners: [{ id: 'packages/a.ts#sweep', count: 2 }] };
        const registry = { transactionOpeners: [{ id: 'packages/a.ts#sweep', count: 2, class: 'downstream-work', basis: BASIS }] };

        expect(computeDirectWriteFindings(facts, registry)).toEqual([]);
    });

    it('reports an unregistered fact, a stale entry and a changed attribute together, sorted', () => {
        const facts = {
            transactionOpeners: [{ id: 'packages/b.ts#write', count: 1 }, { id: 'packages/a.ts#sweep', count: 3 }],
            sqlWriteFiles: [{ id: 'packages/c.ts', statements: ['insert:resource_inbox', 'update:resource_inbox'] }]
        };
        const registry = {
            transactionOpeners: [
                { id: 'packages/a.ts#sweep', count: 2, class: 'downstream-work', basis: BASIS },
                { id: 'packages/z.ts#gone', count: 1, class: 'downstream-work', basis: BASIS }
            ],
            sqlWriteFiles: [{ id: 'packages/c.ts', statements: ['insert:resource_inbox'], class: 'passive-statement', basis: BASIS }]
        };

        expect(computeDirectWriteFindings(facts, registry).map((finding) => finding.line)).toEqual([
            'direct-write.changed sqlWriteFiles packages/c.ts: statements registered ["insert:resource_inbox"], ' +
            'found ["insert:resource_inbox","update:resource_inbox"]',
            'direct-write.changed transactionOpeners packages/a.ts#sweep: count registered 2, found 3',
            'direct-write.stale-entry transactionOpeners packages/z.ts#gone',
            'direct-write.unregistered transactionOpeners packages/b.ts#write'
        ]);
    });

    it('tells the author of an unregistered write what a proposal must say first', () => {
        const [finding] = computeDirectWriteFindings({ admissionBackendWrites: [{ id: 'packages/a.ts#admit', count: 1 }] }, {});

        expect(finding?.advice).toBe(
            'If this write is on an incoming path, the proposal must first say "This writes outside AppInbox" ' +
                '(convergent-service-writing.md, "Writes outside AppInbox"). Code for such a write follows only after the ' +
                'maintainer approves it; without that approval, remove the write. Registering it records that it exists; ' +
                'it is not an approval.'
        );
    });
});
