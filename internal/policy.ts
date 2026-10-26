import { ExpectedError } from "./errors.ts";
import { readText } from "./state.ts";

export type Runner = "docker" | "local";

export interface Policy {
  schema: number;
  runner: Runner;
  cycle: {
    timeoutSec: number;
    defaultWakeMinutes: number;
    minWakeMinutes: number;
    /** Identical tool + args this many times counts as "stuck". */
    repeatThreshold: number;
  };
  /** Off if you don't want snapshots; also skipped automatically when rustic or its password is missing. */
  backup: { enabled: boolean };
  /** The container's clock. The page shows UTC and this, so the two never disagree. */
  timezone: string;
  /** What arrives from people does not accumulate forever. */
  files: {
    /** 0 clears nothing by age: the size cap then governs alone. */
    maxAgeDays: number;
    maxMb: number;
  };
  container: {
    image: string;
    memory: string;
    cpus: string;
    pidsLimit: number;
    /** null means the default docker bridge; set this to a network with egress rules applied. */
    network: string | null;
  };
}

export function defaultPolicy(): Policy {
  return {
    schema: 1,
    runner: "local",
    cycle: { timeoutSec: 1200, defaultWakeMinutes: 30, minWakeMinutes: 1, repeatThreshold: 3 },
    backup: { enabled: true },
    timezone: "Asia/Shanghai",
    files: { maxAgeDays: 0, maxMb: 500 },
    container: {
      image: "geng-agent:latest",
      memory: "2g",
      cpus: "1.5",
      pidsLimit: 512,
      network: null,
    },
  };
}

function num(v: unknown, path: string, min: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) {
    throw new ExpectedError(`policy: ${path} must be a number >= ${min}`);
  }
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ExpectedError(`policy: ${path} must be a non-empty string`);
  }
  return v;
}

/**
 * Missing file -> defaults (init writes it). Present but malformed -> throw,
 * because a silent fallback would change behaviour behind your back.
 */
export function loadPolicy(file: string): Policy {
  const text = readText(file);
  if (text === null) return defaultPolicy();

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ExpectedError(`policy: ${file} is not valid JSON: ${(err as Error).message}`);
  }
  const p = raw as Partial<Policy>;
  const d = defaultPolicy();
  const runner = p.runner ?? d.runner;
  if (runner !== "docker" && runner !== "local") {
    throw new ExpectedError('policy: runner must be "docker" or "local"');
  }
  const cycle = p.cycle ?? d.cycle;
  const container = p.container ?? d.container;
  return {
    schema: p.schema ?? d.schema,
    runner,
    cycle: {
      timeoutSec: num(cycle.timeoutSec, "cycle.timeoutSec", 10),
      defaultWakeMinutes: num(cycle.defaultWakeMinutes, "cycle.defaultWakeMinutes", 1),
      minWakeMinutes: num(cycle.minWakeMinutes, "cycle.minWakeMinutes", 1),
      repeatThreshold: num(cycle.repeatThreshold ?? d.cycle.repeatThreshold, "cycle.repeatThreshold", 2),
    },
    backup: { enabled: p.backup?.enabled !== false },
    timezone: str(p.timezone ?? d.timezone, "timezone"),
    files: {
      maxAgeDays: num(p.files?.maxAgeDays ?? d.files.maxAgeDays, "files.maxAgeDays", 0),
      maxMb: num(p.files?.maxMb ?? d.files.maxMb, "files.maxMb", 1),
    },
    container: {
      image: str(container.image, "container.image"),
      memory: str(container.memory, "container.memory"),
      cpus: str(container.cpus, "container.cpus"),
      pidsLimit: num(container.pidsLimit, "container.pidsLimit", 16),
      network: typeof container.network === "string" && container.network !== "" ? container.network : null,
    },
  };
}
