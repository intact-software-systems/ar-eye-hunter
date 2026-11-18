// Tree listings, diffs, revision files, and paginated API responses grow with the repository and
// outgrow Node's 1 MiB child-process default; a finite bound still stops a runaway command.
export const commandOutputMaxBuffer = 64 * 1024 * 1024;
