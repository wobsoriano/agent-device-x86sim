#!/usr/bin/env node
import { USAGE, UsageError, parseCli } from './cli/args.ts';
import { packagedHookPath } from './cli/hook-path.ts';
import { serve } from './cli/serve.ts';
import { setup } from './cli/setup.ts';

async function main(argv: readonly string[]): Promise<void> {
  const command = parseCli(argv);
  switch (command.kind) {
    case 'help':
      process.stdout.write(USAGE);
      return;
    case 'hook-path':
      process.stdout.write(`${await packagedHookPath()}\n`);
      return;
    case 'serve':
      await serve(command.options);
      return;
    case 'setup':
      await setup(command.options, (line) => process.stderr.write(`${line}\n`));
      return;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  process.stderr.write(`agent-device-x86sim: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
