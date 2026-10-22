// What a case can require of the machine beyond the runner's own
// dependencies (a case's "requires"), and how the runner checks it.
//
// A case whose requirement is missing is skipped with the reason, unless
// CONFORMANCE_REQUIRE names the requirement: then it fails, so a machine
// that must run the case (CI) never skips it quietly.

import { spawnSync } from "node:child_process";

export const REQUIREMENTS = {
  // A container engine: the `docker` CLI, or the one CELLD_DOCKER names, as
  // `celld dev` uses to build images, with a daemon behind it.
  docker: () => {
    const cli = process.env.CELLD_DOCKER || "docker";
    const probe = spawnSync(cli, ["info", "--format", "{{.ServerVersion}}"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (probe.error) return `${cli} cannot run: ${probe.error.message}`;
    if (probe.status !== 0) {
      const detail = probe.stderr.trim().split("\n").at(-1) || `exit status ${probe.status}`;
      return `${cli} info reaches no container engine: ${detail}`;
    }
    return null;
  },
};

/** The requirements CONFORMANCE_REQUIRE (comma-separated) says must be met. */
export function mandatoryRequirements() {
  const names = (process.env.CONFORMANCE_REQUIRE ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names) {
    if (!(name in REQUIREMENTS)) {
      throw new Error(
        `CONFORMANCE_REQUIRE names "${name}", which is not one of ${Object.keys(REQUIREMENTS).join(", ")}`,
      );
    }
  }
  return new Set(names);
}

const verdicts = new Map();

/** Why `name` is not met on this machine, or null. Probed once per run. */
export function missingRequirement(name) {
  if (!verdicts.has(name)) verdicts.set(name, REQUIREMENTS[name]());
  return verdicts.get(name);
}
