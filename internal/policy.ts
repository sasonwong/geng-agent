import { ExpectedError } from "./errors.ts";
import { readText } from "./fs.ts";

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
    /**
     * How the daemon reaches the outside world itself: "auto" (its own environment),
     * "off" (direct, even if the environment says otherwise), or a proxy URL
     * (`http://`, `socks5://`, with optional user:pass).
     */
    proxyChain: string;
    /** Hosts the proxy may reach. `["*"]` is every public host; `[]` is none. */
    proxyAllow: string[];
  };
}

export function defaultPolicy(): Policy {
  return {
    schema: 1,
    runner: "local",
    cycle: { timeoutSec: 1800, defaultWakeMinutes: 30, minWakeMinutes: 1, repeatThreshold: 3 },
    backup: { enabled: true },
    timezone: "Asia/Shanghai",
    files: { maxAgeDays: 0, maxMb: 500 },
    container: {
      image: "geng-agent:latest",
      memory: "2g",
      cpus: "1.5",
      pidsLimit: 512,
      proxyChain: "auto",
      // Every public destination, deliberately: the thing worth blocking is the host's own
      // network, and that is refused by address regardless of this list. Narrow it when the
      // instance should reach a known few.
      proxyAllow: ["*"],
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
      proxyChain: (() => {
        const raw = typeof container.proxyChain === "string" ? container.proxyChain.trim() : d.container.proxyChain;
        if (raw === "" || raw === "auto" || raw === "off") return raw === "" ? "auto" : raw;
        if (!/^(https?|socks5h?):\/\//.test(raw)) {
          throw new ExpectedError(`policy: container.proxyChain 要是 auto、off 或 http(s)/socks5 URL，收到 ${raw}`);
        }
        return raw;
      })(),
      proxyAllow:
        container.proxyAllow === undefined
          ? d.container.proxyAllow
          : (() => {
              // A wildcard here would be an open proxy on the host; direct network is what
              // "let it go anywhere" already means, and it is a different field with a
              // different consequence.
              const list = Array.isArray(container.proxyAllow) ? container.proxyAllow : [];
              if (list.some((x) => String(x).includes("/") || String(x).includes(":"))) {
                throw new ExpectedError("policy: container.proxyAllow 只收主机名（\"*\" 表示全部），不收 URL 或端口");
              }
              return list.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
            })(),
    },
  };
}
