import { StarciteApiError } from "@starcite/sdk";
import { runAppendCommand } from "./commands/append";
import { runConfigCommand } from "./commands/config";
import { runCreateCommand } from "./commands/create";
import { runSessionsCommand } from "./commands/sessions";
import { runTailCommand } from "./commands/tail";
import {
  type CliDependencies,
  CliRuntime,
  CliUsageError,
  type GlobalOptions,
  parseArgs,
} from "./runtime";

declare const __CLI_VERSION__: string;

const HELP_TEXT = `Usage: starcite [options] <command>

Commands:
  config
  create
  append
  tail
  sessions

Options:
  -u, --base-url <url>   Starcite API base URL
  -k, --token <token>    Starcite API key
      --config-dir <path>
      --json
  -h, --help
  -v, --version
`;

const COMMANDS: Record<
  string,
  (args: string[], options: GlobalOptions, runtime: CliRuntime) => Promise<void>
> = {
  config: runConfigCommand,
  create: runCreateCommand,
  append: runAppendCommand,
  tail: runTailCommand,
  sessions: runSessionsCommand,
};

interface ParseContext {
  from?: "user";
}

interface OutputHandlers {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface CliProgram {
  parseAsync(argv: string[], context?: ParseContext): Promise<void>;
  exitOverride(): void;
  configureOutput(output: Partial<OutputHandlers>): void;
}

class EarlyExit extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function normalizeArgv(argv: string[], context?: ParseContext): string[] {
  const args = context?.from === "user" ? [...argv] : argv.slice(2);

  if (
    args[0] === "node" &&
    typeof args[1] === "string" &&
    args[1].includes("starcite")
  ) {
    return args.slice(2);
  }

  return args;
}

function parseGlobalArgs(args: string[]) {
  const parsed = parseArgs(
    {
      "--base-url": String,
      "-u": "--base-url",
      "--token": String,
      "-k": "--token",
      "--config-dir": String,
      "--json": Boolean,
      "--help": Boolean,
      "-h": "--help",
      "--version": Boolean,
      "-v": "--version",
    },
    args,
    true,
  );

  return {
    help: parsed["--help"] === true,
    version: parsed["--version"] === true,
    options: {
      baseUrl: parsed["--base-url"],
      configDir: parsed["--config-dir"],
      token: parsed["--token"],
      json: parsed["--json"] === true,
    },
    rest: parsed._.map((value: unknown) => `${value}`),
  };
}

export function buildProgram(deps: CliDependencies = {}): CliProgram {
  const runtime = new CliRuntime(deps);
  let throwOnEarlyExit = false;
  let output: OutputHandlers = {
    writeOut(text: string) {
      process.stdout.write(text);
    },
    writeErr(text: string) {
      process.stderr.write(text);
    },
  };

  return {
    exitOverride() {
      throwOnEarlyExit = true;
    },

    configureOutput(next) {
      output = {
        writeOut: next.writeOut ?? output.writeOut,
        writeErr: next.writeErr ?? output.writeErr,
      };
    },

    async parseAsync(argv, context) {
      const parsed = parseGlobalArgs(normalizeArgv(argv, context));
      const command = parsed.rest[0];

      if (parsed.version) {
        output.writeOut(`${__CLI_VERSION__}\n`);
        if (throwOnEarlyExit) throw new EarlyExit("cli.versionDisplayed", "Version displayed");
        return;
      }

      if (parsed.help || !command) {
        output.writeOut(`${HELP_TEXT}\n`);
        if (throwOnEarlyExit) throw new EarlyExit("cli.helpDisplayed", "Help displayed");
        return;
      }

      const handler = COMMANDS[command];
      if (!handler) throw new CliUsageError(`Unknown command: ${command}`);

      await handler(parsed.rest.slice(1), parsed.options, runtime);
    },
  };
}

export async function run(
  argv = process.argv,
  deps: CliDependencies = {},
): Promise<void> {
  const runtime = new CliRuntime(deps);
  const program = buildProgram(deps);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof StarciteApiError) {
      runtime.logger.error(`${error.code} (${error.status}): ${error.message}`);
      process.exitCode = 1;
      return;
    }

    if (error instanceof Error) {
      runtime.logger.error(error.message);
      process.exitCode = 1;
      return;
    }

    runtime.logger.error("Unknown error");
    process.exitCode = 1;
  }
}
