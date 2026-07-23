import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const MAX_NEW_TYPESCRIPT_LINES = 400;
const WORKTREE_TARGET = "WORKTREE";

function runGit(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function countPhysicalLines(source) {
  if (source.length === 0) return 0;
  const lines = source.split(/\r?\n/u);
  return source.endsWith("\n") ? lines.length - 1 : lines.length;
}

function readRevisionFile(revision, path) {
  const result = spawnSync("git", ["show", `${revision}:${path}`], {
    encoding: "utf8",
  });
  if (result.status === 0) return result.stdout;
  return undefined;
}

function changedTypeScriptPaths(baseRevision, target) {
  const diffArgs = target === WORKTREE_TARGET
    ? ["diff", "--name-only", "--diff-filter=ACMR", baseRevision, "--", "*.ts"]
    : ["diff", "--name-only", "--diff-filter=ACMR", baseRevision, target, "--", "*.ts"];
  const paths = runGit(diffArgs).trim().split("\n").filter(Boolean);

  if (target === WORKTREE_TARGET) {
    paths.push(...runGit([
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      "*.ts",
    ]).trim().split("\n").filter(Boolean));
  }

  return [...new Set(paths)].sort();
}

function readTargetFile(target, path) {
  if (target === WORKTREE_TARGET) return readFileSync(path, "utf8");
  const source = readRevisionFile(target, path);
  if (source === undefined) throw new Error(`Could not read ${target}:${path}`);
  return source;
}

const [baseRevision, target = WORKTREE_TARGET] = process.argv.slice(2);
if (!baseRevision) {
  console.error(
    "Usage: node scripts/check-changed-ts-file-growth.mjs <base-revision> [target-revision|WORKTREE]",
  );
  process.exit(2);
}

const offenders = [];
for (const path of changedTypeScriptPaths(baseRevision, target)) {
  const baseSource = readRevisionFile(baseRevision, path);
  const baseLines = baseSource === undefined ? undefined : countPhysicalLines(baseSource);
  const targetLines = countPhysicalLines(readTargetFile(target, path));

  if (baseLines === undefined && targetLines > MAX_NEW_TYPESCRIPT_LINES) {
    offenders.push({ path, kind: "new-over-limit", baseLines, targetLines });
  } else if (
    baseLines !== undefined &&
    baseLines > MAX_NEW_TYPESCRIPT_LINES &&
    targetLines > baseLines
  ) {
    offenders.push({ path, kind: "existing-over-limit-grew", baseLines, targetLines });
  }
}

if (offenders.length === 0) {
  console.log(
    `PASS: no changed TypeScript file is newly over ${MAX_NEW_TYPESCRIPT_LINES} lines or grew above an over-limit base (${baseRevision} -> ${target}).`,
  );
  process.exit(0);
}

console.error(
  `FAIL: ${offenders.length} TypeScript file(s) violate the ${MAX_NEW_TYPESCRIPT_LINES}-line growth policy (${baseRevision} -> ${target}):`,
);
for (const offender of offenders) {
  const base = offender.baseLines === undefined ? "new" : offender.baseLines;
  console.error(
    `${offender.kind}\t${base} -> ${offender.targetLines}\t${offender.path}`,
  );
}
process.exit(1);
