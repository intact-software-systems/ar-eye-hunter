#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const manifestPaths = process.argv.slice(2);

if (manifestPaths.length === 0) {
  console.error('Usage: validate-hetzner-shared-preparation.mjs <manifest.json> [...]');
  process.exitCode = 2;
} else {
  const incompatibleManifests = [];

  for (const manifestPath of manifestPaths) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      console.error(`Unable to read supported-suite manifest ${manifestPath}: ${error.message}`);
      process.exitCode = 2;
      break;
    }

    const rtcTopologyEnv = manifest?.metadata?.rtcTopologyEnv;
    if (rtcTopologyEnv && Object.keys(rtcTopologyEnv).length > 0) {
      incompatibleManifests.push(manifestPath);
    }
  }

  if (!process.exitCode && incompatibleManifests.length > 0) {
    for (const manifestPath of incompatibleManifests) {
      console.error(
        `${manifestPath} sets metadata.rtcTopologyEnv and requires its own preparation cohort.`,
      );
    }
    process.exitCode = 1;
  } else if (!process.exitCode) {
    console.log(
      `Validated ${manifestPaths.length} supported manifest(s) for one shared preparation cohort.`,
    );
  }
}
