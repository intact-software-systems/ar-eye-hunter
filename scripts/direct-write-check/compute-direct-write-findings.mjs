import { DIRECT_WRITE_FACT_SETS } from './direct-write-registry.mjs';

const UNREGISTERED_ADVICE =
    'If this write is on an incoming path, the proposal must first say "This writes outside AppInbox" ' +
    '(convergent-service-writing.md, "Writes outside AppInbox"). Registering it records that it exists; ' +
    'it is not an approval.';
const STALE_ADVICE = 'Remove the entry, or re-key it to the owner that now holds the write; neither changes a review.';

/** Compares source facts with registry entries in both directions; a fact's identity is its fact set and id. */
export function computeDirectWriteFindings(facts, registry) {
    const findings = DIRECT_WRITE_FACT_SETS.flatMap((factSet) =>
        computeFactSetFindings(factSet, facts[factSet] ?? [], registry[factSet] ?? [])
    );
    return findings.toSorted((left, right) => left.line < right.line ? -1 : left.line > right.line ? 1 : 0);
}

function computeFactSetFindings(factSet, facts, entries) {
    const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
    const factIds = new Set(facts.map((fact) => fact.id));
    const findings = [];
    for (const fact of facts) {
        const entry = entriesById.get(fact.id);
        if (entry === undefined) {
            findings.push(toFinding('direct-write.unregistered', `${factSet} ${fact.id}`, UNREGISTERED_ADVICE));
            continue;
        }
        findings.push(...computeAttributeFindings(factSet, fact, entry));
    }
    for (const entry of entries.filter((candidate) => !factIds.has(candidate.id))) {
        findings.push(toFinding('direct-write.stale-entry', `${factSet} ${entry.id}`, STALE_ADVICE));
    }
    return findings;
}

function computeAttributeFindings(factSet, fact, entry) {
    return Object.keys(fact)
        .filter((attribute) => attribute !== 'id')
        .filter((attribute) => JSON.stringify(fact[attribute]) !== JSON.stringify(entry[attribute]))
        .map((attribute) =>
            toFinding(
                'direct-write.changed',
                `${factSet} ${fact.id}: ${attribute} registered ${JSON.stringify(entry[attribute])}, ` +
                    `found ${JSON.stringify(fact[attribute])}`,
                'Update the entry to what the source now holds, and say in the pull request why it changed.'
            )
        );
}

function toFinding(code, subject, advice) {
    return { code, line: `${code} ${subject}`, advice };
}
