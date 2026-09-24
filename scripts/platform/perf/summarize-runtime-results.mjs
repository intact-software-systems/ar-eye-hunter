import { readFileSync, writeFileSync } from 'node:fs';

const input = process.argv[2] ?? 'tmp/perf/results/runtime-validation-focused-runs3.json';
const output = process.argv[3] ?? 'tmp/perf/results/runtime-validation-focused-summary.json';

const data = JSON.parse(readFileSync(input, 'utf8'));
const groups = new Map();

for (const row of data.results ?? []) {
    const key = `${row.name}||${row.sizeLabel}`;
    const group = groups.get(key) ?? {
        name: row.name,
        sizeLabel: row.sizeLabel,
        runs: 0,
        durations: [],
        heapDeltas: [],
        rssDeltas: [],
        details: row.details
    };
    group.runs += 1;
    group.durations.push(row.durationMs);
    group.heapDeltas.push(row.memoryAfter.heapUsed - row.memoryBefore.heapUsed);
    group.rssDeltas.push(row.memoryAfter.rss - row.memoryBefore.rss);
    group.details = { ...group.details, ...row.details };
    groups.set(key, group);
}

function sorted(values) {
    return [...values].sort((a, b) => a - b);
}

function percentile(values, p) {
    if (values.length === 0) {
        return null;
    }
    const vals = sorted(values);
    const idx = Math.min(vals.length - 1, Math.max(0, Math.ceil((p / 100) * vals.length) - 1));
    return vals[idx];
}

function round(value) {
    return value === null ? null : Math.round(value * 1000) / 1000;
}

const summary = [...groups.values()]
    .map((group) => ({
        name: group.name,
        sizeLabel: group.sizeLabel,
        runs: group.runs,
        durationMs: {
            min: round(Math.min(...group.durations)),
            median: round(percentile(group.durations, 50)),
            p95Approx: round(percentile(group.durations, 95)),
            max: round(Math.max(...group.durations))
        },
        heapDeltaBytes: {
            median: Math.round(percentile(group.heapDeltas, 50)),
            max: Math.round(Math.max(...group.heapDeltas))
        },
        rssDeltaBytes: {
            median: Math.round(percentile(group.rssDeltas, 50)),
            max: Math.round(Math.max(...group.rssDeltas))
        },
        details: group.details
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.sizeLabel.localeCompare(b.sizeLabel));

writeFileSync(
    output,
    JSON.stringify(
        {
            source: input,
            generatedAt: new Date().toISOString(),
            summary
        },
        null,
        2
    )
);

for (const row of summary) {
    console.log(`${row.name} | ${row.sizeLabel} | median ${row.durationMs.median} ms | max ${row.durationMs.max} ms`);
}
