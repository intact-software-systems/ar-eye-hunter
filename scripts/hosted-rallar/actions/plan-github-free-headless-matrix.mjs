#!/usr/bin/env node

const MAX_GITHUB_FREE_AGENT_JOBS = 19;

function parseArgs(argv) {
    const values = new Map();
    for (const arg of argv) {
        const match = arg.match(/^--([^=]+)=(.*)$/);
        if (!match) {
            fail(`Unsupported argument: ${arg}`);
        }
        values.set(match[1], match[2]);
    }
    return values;
}

function positiveIntegerArg(values, name) {
    const raw = values.get(name);
    if (!raw || !/^[1-9][0-9]*$/.test(raw)) {
        fail(`${name.replaceAll('-', '_')} must be a positive integer`);
    }
    return Number.parseInt(raw, 10);
}

function stringArg(values, name) {
    const raw = values.get(name);
    if (!raw) {
        fail(`${name.replaceAll('-', '_')} is required`);
    }
    return raw;
}

function fail(message) {
    console.error(message);
    process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const targetAgentCount = positiveIntegerArg(args, 'target-agent-count');
const agentsPerJob = positiveIntegerArg(args, 'agents-per-job');
const maxParallelJobs = positiveIntegerArg(args, 'max-parallel-jobs');
const runId = stringArg(args, 'run-id');

if (maxParallelJobs > MAX_GITHUB_FREE_AGENT_JOBS) {
    fail('max_parallel_jobs must be between 1 and 19 for GitHub Free');
}

const shardCount = Math.ceil(targetAgentCount / agentsPerJob);
if (shardCount > maxParallelJobs) {
    fail('shard_count must not exceed max_parallel_jobs');
}

const matrix = [];
for (let start = 1, shard = 1; start <= targetAgentCount; shard += 1) {
    const remaining = targetAgentCount - start + 1;
    const agentCount = Math.min(agentsPerJob, remaining);
    matrix.push({
        shard_index: shard,
        agent_start_index: start,
        agent_count: agentCount
    });
    start += agentCount;
}

const estimatedSetupMinutes = shardCount * 5 + 5;
const estimatedSixtyMinuteRunMinutes = (shardCount + 1) * 60;

process.stdout.write(`${
    JSON.stringify({
        runId,
        distributedRunId: `dist-${runId}`,
        maxParallelJobs,
        estimatedSetupMinutes,
        estimatedSixtyMinuteRunMinutes,
        matrix
    })
}\n`);
