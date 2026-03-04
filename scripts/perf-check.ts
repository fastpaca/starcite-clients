import { spawnSync } from "node:child_process";

interface PerfMetricThreshold {
  ciMaxMeanMs?: number;
  maxMeanMs: number;
  name: string;
}

interface PerfScope {
  cwd: string;
  metrics: PerfMetricThreshold[];
  name: string;
}

const newlinePattern = /\r?\n/;

const perfScopes: PerfScope[] = [
  {
    name: "@starcite/sdk",
    cwd: "packages/typescript-sdk",
    metrics: [
      {
        name: "append HTTP roundtrip RTT (loopback)",
        maxMeanMs: 1.5,
        ciMaxMeanMs: 3.0,
      },
      {
        name: "tail replay catch-up RTT from cursor (loopback websocket)",
        maxMeanMs: 2.0,
        ciMaxMeanMs: 4.0,
      },
      {
        name: "append -> live on('event') delivery RTT (HTTP + websocket loopback)",
        maxMeanMs: 3.0,
        ciMaxMeanMs: 5.0,
      },
      {
        name: "apply contiguous 500-event batch",
        maxMeanMs: 0.2,
        ciMaxMeanMs: 0.5,
      },
      {
        name: "deduplicate replayed 500-event batch",
        maxMeanMs: 0.3,
        ciMaxMeanMs: 0.8,
      },
      {
        name: "parse a 100-event websocket frame",
        maxMeanMs: 0.25,
        ciMaxMeanMs: 0.5,
      },
    ],
  },
  {
    name: "@starcite/react",
    cwd: "packages/starcite-react",
    metrics: [
      {
        name: "project 50-turn conversation to UI messages",
        maxMeanMs: 3.0,
        ciMaxMeanMs: 7.0,
      },
      {
        name: "project 50-turn conversation with full replay duplicates",
        maxMeanMs: 5.0,
        ciMaxMeanMs: 10.0,
      },
    ],
  },
];

function runBench(scope: PerfScope): string {
  const command = "bun";
  const args = ["run", "--cwd", scope.cwd, "bench"];

  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = `${stdout}\n${stderr}`;

  process.stdout.write(stdout);
  process.stderr.write(stderr);

  if (result.status !== 0) {
    throw new Error(
      `${scope.name} benchmark command failed with exit code ${result.status ?? "unknown"}`
    );
  }

  return output;
}

function extractMeanMs(output: string, metricName: string): number {
  const lines = output.split(newlinePattern);

  for (const line of lines) {
    if (!line.includes(metricName)) {
      continue;
    }

    const numericColumns = line.match(/[0-9][0-9,]*\.[0-9]+/g) ?? [];
    if (numericColumns.length < 4) {
      continue;
    }

    const meanColumn = numericColumns[3];
    if (!meanColumn) {
      continue;
    }

    const meanMs = Number.parseFloat(meanColumn.replace(/,/g, ""));
    if (!Number.isFinite(meanMs)) {
      continue;
    }

    return meanMs;
  }

  throw new Error(`Could not extract mean benchmark value for '${metricName}'`);
}

function main(): void {
  const failures: string[] = [];
  const runningInCi = Boolean(process.env.CI);

  for (const scope of perfScopes) {
    console.log(`\n[perf:check] Running benchmarks for ${scope.name}`);
    const output = runBench(scope);

    for (const metric of scope.metrics) {
      const meanMs = extractMeanMs(output, metric.name);
      const thresholdMs =
        runningInCi && metric.ciMaxMeanMs !== undefined
          ? metric.ciMaxMeanMs
          : metric.maxMeanMs;
      const summary = `${scope.name}: ${metric.name} mean=${meanMs.toFixed(
        4
      )}ms threshold<=${thresholdMs.toFixed(4)}ms`;

      if (meanMs <= 0) {
        failures.push(`${summary} (invalid non-positive mean)`);
        console.error(`[perf:check] FAIL ${summary}`);
        continue;
      }

      if (meanMs > thresholdMs) {
        failures.push(summary);
        console.error(`[perf:check] FAIL ${summary}`);
        continue;
      }

      console.log(`[perf:check] PASS ${summary}`);
    }
  }

  if (failures.length > 0) {
    console.error("\n[perf:check] Threshold failures:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("\n[perf:check] All performance thresholds passed.");
}

main();
