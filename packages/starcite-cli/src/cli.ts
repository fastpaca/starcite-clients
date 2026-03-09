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
  parseArgs,
} from "./runtime";

const HELP_CODE = "commander.helpDisplayed";

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
`;

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
    },
    args,
    true
  );

  return {
    help: parsed["--help"] === true,
    options: {
      baseUrl: parsed["--base-url"],
      configDir: parsed["--config-dir"],
      token: parsed["--token"],
      json: parsed["--json"] === true,
    },
    rest: parsed._.map((value: unknown) => `${value}`),
  };
}

function helpOutputText(): string {
  return `${HELP_TEXT}\n`;
}

export function buildProgram(deps: CliDependencies = {}): CliProgram {
  const runtime = new CliRuntime(deps);
  let shouldThrowOnHelp = false;
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
      shouldThrowOnHelp = true;
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

      if (parsed.help || !command) {
        output.writeOut(helpOutputText());

        if (shouldThrowOnHelp) {
          const error = new Error("Help displayed") as Error & { code: string };
          error.code = HELP_CODE;
          throw error;
        }

        return;
      }

      const commandArgs = parsed.rest.slice(1);

      if (command === "config") {
        await runConfigCommand(commandArgs, parsed.options, runtime);
        return;
      }

      if (command === "create") {
        await runCreateCommand(commandArgs, parsed.options, runtime);
        return;
      }

      if (command === "append") {
        await runAppendCommand(commandArgs, parsed.options, runtime);
        return;
      }

      if (command === "tail") {
        await runTailCommand(commandArgs, parsed.options, runtime);
        return;
      }

      if (command === "sessions") {
        await runSessionsCommand(commandArgs, parsed.options, runtime);
        return;
      }

      throw new CliUsageError(`Unknown command: ${command}`);
    },
  };
}

export async function run(
  argv = process.argv,
  deps: CliDependencies = {}
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
