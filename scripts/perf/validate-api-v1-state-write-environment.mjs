const PINNED_POSTGRES_IMAGE =
  'postgres@sha256:081f1bc7bd5e143dbb6e487b710bbc27712cdcfaced4c071b8e47349aa1b4171';
const PINNED_POSTGRES_IMAGE_ID =
  'sha256:081f1bc7bd5e143dbb6e487b710bbc27712cdcfaced4c071b8e47349aa1b4171';

const ENVIRONMENT_FIELDS = [
  'image_ref',
  'image_id',
  'repo_digest',
  'platform',
  'image_architecture',
  'image_os',
  'entrypoint',
  'command',
  'shm_size',
  'memory',
  'memory_swap',
  'nano_cpus',
  'cpu_period',
  'cpu_quota',
  'cpu_set',
  'server_version',
  'autovacuum',
  'track_counts',
  'shared_buffers',
  'work_mem',
  'maintenance_work_mem',
  'effective_cache_size',
  'random_page_cost',
  'effective_io_concurrency',
  'synchronous_commit',
  'fsync',
  'full_page_writes',
  'max_wal_size',
  'checkpoint_timeout',
  'jit',
  'max_parallel_workers_per_gather',
  'host_architecture',
  'node',
  'npm',
  'deno',
  'deno_v8',
  'deno_typescript',
  'docker',
  'docker_compose',
  'fresh_container',
  'container_overlap_count',
  'benchmark_process_overlap_count',
  'preflight_app_data_store_rows',
  'preflight_client_state_events_rows',
  'preflight_group_state_events_rows',
  'preflight_resource_inbox_rows',
  'preflight_resource_inbox_results_rows',
  'preflight_runtime_state_store_rows',
  'preflight_automatic_maintenance_count',
  'postflight_automatic_maintenance_count',
];

const EXACT_VALUES = {
  image_ref: PINNED_POSTGRES_IMAGE,
  image_id: PINNED_POSTGRES_IMAGE_ID,
  repo_digest: PINNED_POSTGRES_IMAGE,
  platform: 'linux',
  image_os: 'linux',
  entrypoint: 'docker-entrypoint.sh',
  command: 'postgres -c autovacuum=off',
  shm_size: '268435456',
  memory: '4294967296',
  memory_swap: '4294967296',
  nano_cpus: '4000000000',
  cpu_period: '0',
  cpu_quota: '0',
  cpu_set: '',
  autovacuum: 'off',
  track_counts: 'on',
  shared_buffers: '16384',
  work_mem: '4096',
  maintenance_work_mem: '65536',
  effective_cache_size: '524288',
  random_page_cost: '4',
  effective_io_concurrency: '1',
  synchronous_commit: 'on',
  fsync: 'on',
  full_page_writes: 'on',
  max_wal_size: '1024',
  checkpoint_timeout: '300',
  jit: 'on',
  max_parallel_workers_per_gather: '2',
  fresh_container: 'true',
  container_overlap_count: '0',
  benchmark_process_overlap_count: '0',
  preflight_app_data_store_rows: '0',
  preflight_client_state_events_rows: '0',
  preflight_group_state_events_rows: '0',
  preflight_resource_inbox_rows: '0',
  preflight_resource_inbox_results_rows: '0',
  preflight_runtime_state_store_rows: '0',
  preflight_automatic_maintenance_count: '0',
  postflight_automatic_maintenance_count: '0',
};

const NONEMPTY_FIELDS = [
  'image_architecture',
  'host_architecture',
  'node',
  'npm',
  'deno',
  'deno_v8',
  'deno_typescript',
  'docker',
  'docker_compose',
];

export function validateApiV1StateWriteEnvironment(environmentText) {
  const errors = [];
  const record = parseEnvironmentRecord(environmentText, errors);
  if (record === undefined) {
    return errors;
  }
  validateFieldSet(record, errors);
  validateExactValues(record, errors);
  validateRuntimeValues(record, errors);
  return errors;
}

function parseEnvironmentRecord(environmentText, errors) {
  if (typeof environmentText !== 'string' || !environmentText.endsWith('\n')) {
    errors.push('environment record must be newline-terminated text');
    return undefined;
  }
  const record = {};
  for (const line of environmentText.slice(0, -1).split('\n')) {
    const separator = line.indexOf('=');
    if (separator < 1) {
      errors.push('environment record contains a malformed field');
      continue;
    }
    const key = line.slice(0, separator);
    if (Object.hasOwn(record, key)) {
      errors.push(`environment record contains duplicate field ${key}`);
      continue;
    }
    record[key] = line.slice(separator + 1);
  }
  return record;
}

function validateFieldSet(record, errors) {
  const actual = Object.keys(record).sort();
  const expected = [...ENVIRONMENT_FIELDS].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push('environment record fields must match the governed schema');
  }
}

function validateExactValues(record, errors) {
  for (const [field, expected] of Object.entries(EXACT_VALUES)) {
    if (record[field] !== expected) {
      errors.push(`environment record ${field} must equal ${expected}`);
    }
  }
}

function validateRuntimeValues(record, errors) {
  if (!/^16\./.test(record.server_version ?? '')) {
    errors.push('environment record server_version must identify PostgreSQL 16');
  }
  if (record.image_architecture !== record.host_architecture) {
    errors.push('environment record image and host architectures must match');
  }
  for (const field of NONEMPTY_FIELDS) {
    if (typeof record[field] !== 'string' || record[field].length === 0) {
      errors.push(`environment record ${field} must be non-empty`);
    }
  }
}
