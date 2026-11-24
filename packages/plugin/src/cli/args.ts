import { parseArgs } from 'node:util';

/** The x86Sim release `setup` downloads, the one this package is tested with. */
export const X86SIM_VERSION = '0.5.3';
export const DEFAULT_MODEL = 'iPhone 17 Pro';

export type ServeOptions = {
  appimage?: string;
  device?: string;
  host: string;
  port: number;
  verbose: boolean;
};

export type SetupOptions = {
  appimage?: string;
  /** The name of the phone to create. Else the model's name. */
  device?: string;
  model: string;
};

export type Command =
  | { kind: 'serve'; options: ServeOptions }
  | { kind: 'setup'; options: SetupOptions }
  | { kind: 'hook-path' }
  | { kind: 'help' };

/** A mistake in the command line. The CLI prints it with the usage text and exits with 2. */
export class UsageError extends Error {}

export const USAGE = `Usage: agent-device-x86sim <command>

Commands:
  setup        Download x86Sim and iOS, and create a phone. Run it once on the Linux machine.
  serve        Prepare the phone and run the server that agent-device connects to.
  hook-path    Print the path of the accessibility hook this package ships.

Options of setup:
  --appimage PATH     The x86Sim AppImage. Else $X86SIM_APPIMAGE, else
                      ~/x86sim/x86sim-${X86SIM_VERSION}-x86_64.AppImage, downloaded when it is missing.
  --device NAME       The name of the phone to create. Default: the model's name.
  --model MODEL       The model of the phone to create. Default: ${DEFAULT_MODEL}.

Options of serve:
  --appimage PATH     The x86Sim AppImage. Else $X86SIM_APPIMAGE, else the copy in x86Sim's data folder.
  --device NAME|DIR   The phone, such as device-a64-iphone-17-pro, or its folder. Else the only phone
                      x86Sim has created.
  --port PORT         Default 4723.
  --host HOST         Default 127.0.0.1.
  --verbose           Log every request and the output of x86Sim's boot script.
`;

function parsePort(text: string): number {
  const port = Number(text);
  if (!/^\d+$/.test(text) || port > 65_535)
    throw new UsageError(`--port must be a number from 0 to 65535, not "${text}".`);
  return port;
}

const OPTIONS = {
  appimage: { type: 'string' },
  device: { type: 'string' },
  model: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  verbose: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

function scan(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/** Turns the arguments after `node cli.js` into a command. */
export function parseCli(argv: readonly string[]): Command {
  const { values, positionals } = scan(argv);
  const [command, ...extra] = positionals;
  if (values.help || command === undefined || command === 'help') return { kind: 'help' };
  if (extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}".`);
  switch (command) {
    case 'hook-path':
      return { kind: 'hook-path' };
    case 'setup':
      return {
        kind: 'setup',
        options: {
          ...(values.appimage === undefined ? {} : { appimage: values.appimage }),
          ...(values.device === undefined ? {} : { device: values.device }),
          model: values.model ?? DEFAULT_MODEL,
        },
      };
    case 'serve':
      return {
        kind: 'serve',
        options: {
          ...(values.appimage === undefined ? {} : { appimage: values.appimage }),
          ...(values.device === undefined ? {} : { device: values.device }),
          host: values.host ?? '127.0.0.1',
          port: parsePort(values.port ?? '4723'),
          verbose: values.verbose ?? false,
        },
      };
    default:
      throw new UsageError(`Unknown command "${command}".`);
  }
}
