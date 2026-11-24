/**
 * Golden comparison of `snapshot` between Apple's XCTest and the x86Sim accessibility hook.
 *
 * `capture` drives an iOS simulator on a Mac, where agent-device reads the tree through XCTest,
 * and saves one fixture per screen in `scripts/ax-golden/`. `check` drives a phone under x86Sim
 * through the plugin, takes the same screens, and exits 1 with a diff when a screen differs from
 * its fixture. Each element is compared as one line: the types of its listed ancestors, then its
 * own type, label and identifier. Refs, frames and values are left out.
 *
 * It compares the full tree, not `snapshot -i`. agent-device prunes `-i` differently for XCTest and
 * for a WebDriver page source, so `-i` can differ when the trees are the same.
 *
 *   node scripts/ax-golden.ts capture --udid <mac simulator udid> [--screen <name>]
 *   X86SIM_WEBDRIVER_ENDPOINT=http://127.0.0.1:4723 node scripts/ax-golden.ts check [--screen <name>]
 *
 * Run `vp run agent-device-x86sim#build` before `check`.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { startAgentDevice } from 'agent-device';
import x86sim from 'agent-device-x86sim/agent-device';

export const FIXTURE_DIR = path.join(import.meta.dirname, 'ax-golden');

type Step = { open: string } | { press: string };

export type Screen = {
  name: string;
  steps: Step[];
  /** The screen counts as reached once an element with this label is listed. */
  ready: string;
};

const SETTINGS = 'com.apple.Preferences';

export const SCREENS: Screen[] = [
  { name: 'settings', steps: [{ open: SETTINGS }], ready: 'General' },
  { name: 'general', steps: [{ open: SETTINGS }, { press: 'General' }], ready: 'About' },
  { name: 'accessibility', steps: [{ open: SETTINGS }, { press: 'Accessibility' }], ready: 'VoiceOver' },
];

/** What `snapshot -i --json` lists for one element, as far as the comparison reads it. */
export type Listed = {
  index?: number;
  parentIndex?: number;
  type: string;
  /** iOS only: the nearest public UIKit class, `UIApplication` for the root. */
  subrole?: string;
  label?: string;
  identifier?: string;
};

/** An expected line that may be missing, or an unexpected line that may appear, with the reason. */
type Allowance = { line: string; reason: string };

export type Fixture = {
  screen: string;
  capturedOn: string;
  lines: string[];
  allow: { missing: Allowance[]; extra: Allowance[] };
};

/**
 * XCTest reports the application as Other, and a WebDriver page source as Application, which
 * agent-device keeps as it comes. Both are written as `App`.
 */
/** XCUIElementType names by number, as XCUIAutomation's XCUIElementTypes.h numbers them. */
const ELEMENT_TYPES =
  'Any Other Application Group Window Sheet Drawer Alert Dialog Button RadioButton RadioGroup CheckBox DisclosureTriangle PopUpButton ComboBox MenuButton ToolbarButton Popover Keyboard Key NavigationBar TabBar TabGroup Toolbar StatusBar Table TableRow TableColumn Outline OutlineRow Browser CollectionView Slider PageIndicator ProgressIndicator ActivityIndicator SegmentedControl Picker PickerWheel Switch Toggle Link Image Icon SearchField ScrollView ScrollBar StaticText TextField SecureTextField DatePicker TextView Menu MenuItem MenuBar MenuBarItem Map WebView IncrementArrow DecrementArrow Timeline RatingIndicator ValueIndicator SplitGroup Splitter RelevanceIndicator ColorWell HelpTag Matte DockItem Ruler RulerMarker Grid LevelIndicator Cell LayoutArea LayoutItem Handle Stepper Tab TouchBar StatusItem'.split(
    ' ',
  );

/**
 * A WebDriver type keeps its `XCUIElementType` prefix. XCTest's agent-device runner names a type
 * it has no name for by number, such as `Element(25)` for StatusBar.
 */
const typeOf = (node: Listed) => {
  const numbered = /^Element\((\d+)\)$/.exec(node.type)?.[1];
  const type = (numbered && ELEMENT_TYPES[Number(numbered)]) || node.type.replace(/^XCUIElementType/, '');
  return type === 'Application' || node.subrole === 'UIApplication' ? 'App' : type;
};

/**
 * agent-device labels a WebDriver element that has no label with its name, which is its
 * identifier, and XCTest leaves it unlabelled. A label equal to the identifier is left out on both.
 */
// iOS writes a narrow no-break space before AM and PM.
const CLOCK = /\b\d{1,2}:\d{2}(?:[\s\u202f][AP]M)?/g;

const describe = (node: Listed) =>
  [
    typeOf(node),
    // The status bar's clock changes between runs.
    node.label && node.label !== node.identifier ? JSON.stringify(node.label.replace(CLOCK, '<time>')) : '',
    node.identifier ? `#${node.identifier}` : '',
  ]
    .filter(Boolean)
    .join(' ');

/** One line per listed element: the types of its listed ancestors, then the element itself. */
export function normalize(nodes: readonly Listed[]): string[] {
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  return nodes.map((node) => {
    const chain: string[] = [];
    for (let up = byIndex.get(node.parentIndex); up; up = byIndex.get(up.parentIndex)) {
      chain.unshift(typeOf(up));
    }
    return [...chain, describe(node)].join(' > ');
  });
}

/** Lines only in `expected` (missing) and only in `actual` (extra), by longest common subsequence. */
export function diffLines(expected: readonly string[], actual: readonly string[]) {
  const n = expected.length;
  const m = actual.length;
  const lcs = Array.from({ length: n + 1 }, () => Array.from<number>({ length: m + 1 }).fill(0));
  for (let i = n - 1; i >= 0; i -= 1)
    for (let j = m - 1; j >= 0; j -= 1)
      lcs[i]![j] = expected[i] === actual[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: Array<{ op: ' ' | '-' | '+'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && expected[i] === actual[j]) {
      ops.push({ op: ' ', line: expected[i]! });
      i += 1;
      j += 1;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      ops.push({ op: '+', line: actual[j]! });
      j += 1;
    } else {
      ops.push({ op: '-', line: expected[i]! });
      i += 1;
    }
  }
  return ops;
}

/** How many times each line may differ. One allowance covers one occurrence of its line. */
const allowances = (list: readonly Allowance[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const { line } of list) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
};

/** The diff of one screen with allowed lines dropped, or an empty list when it matches. */
export function compare(fixture: Fixture, actual: readonly string[]) {
  const missingOk = allowances(fixture.allow.missing);
  const extraOk = allowances(fixture.allow.extra);
  const spend = (budget: Map<string, number>, line: string): boolean => {
    const left = budget.get(line) ?? 0;
    if (left > 0) budget.set(line, left - 1);
    return left > 0;
  };
  const ops = diffLines(fixture.lines, actual).filter(
    ({ op, line }) => !(op === '-' && spend(missingOk, line)) && !(op === '+' && spend(extraOk, line)),
  );
  return ops.some(({ op }) => op !== ' ') ? ops : [];
}

const fixturePath = (screen: string) => path.join(FIXTURE_DIR, `${screen}.json`);

async function readFixture(screen: string): Promise<Fixture | undefined> {
  try {
    return JSON.parse(await readFile(fixturePath(screen), 'utf8')) as Fixture;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The calls a screen needs, on either side. */
export type Driver = {
  open(app: string): Promise<void>;
  press(label: string): Promise<void>;
  snapshot(): Promise<Listed[]>;
  close(): Promise<void>;
};

const READY_TIMEOUT_MS = 90_000;

/**
 * Runs a screen's steps and takes interactive snapshots until it is reached. A launch or a
 * navigation animates before the new screen's elements exist, and on x86Sim it takes seconds.
 */
export async function visit(driver: Driver, screen: Screen): Promise<Listed[]> {
  for (const step of screen.steps) {
    if ('open' in step) await driver.open(step.open);
    else await driver.press(step.press);
  }
  const startedAt = performance.now();
  let failure = '';
  for (;;) {
    // An app that is still launching has no hook to answer yet, so a failed snapshot is tried again.
    const nodes = await driver.snapshot().catch((error: unknown) => {
      failure = `, last error: ${error instanceof Error ? error.message : String(error)}`;
      return [];
    });
    if (nodes.some((node) => node.label === screen.ready)) {
      // One more snapshot, so a list still filling in after the label appeared is not what gets compared.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return await driver.snapshot();
    }
    if (performance.now() - startedAt > READY_TIMEOUT_MS)
      throw new Error(`${screen.name}: no element labelled "${screen.ready}" within ${READY_TIMEOUT_MS} ms${failure}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

type Client = Awaited<ReturnType<typeof startAgentDevice>>['client'];

function driverFor(client: Client, target: Record<string, string>): Driver {
  return {
    open: async (app) => void (await client.apps.open({ ...target, app, relaunch: true })),
    press: async (label) =>
      void (await client.interactions.press({ ...target, selector: `label=${JSON.stringify(label)}` })),
    snapshot: async () => (await client.capture.snapshot({ ...target })).nodes as Listed[],
    close: async () => void (await client.sessions.close({ ...target }).catch(() => undefined)),
  };
}

/** Agent-device in this process, with a driver for the Mac simulator or for x86Sim. */
async function start(mode: 'capture' | 'check', udid: string | undefined) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'ax-golden-'));
  if (mode === 'capture') {
    const host = await startAgentDevice({ stateDir });
    const driver = driverFor(host.client, { session: 'ax-golden', platform: 'ios', udid: udid! });
    return { driver, stop: async () => (await host.close(), await rm(stateDir, { recursive: true, force: true })) };
  }
  const endpoint = process.env.X86SIM_WEBDRIVER_ENDPOINT ?? 'http://127.0.0.1:4723';
  const host = await startAgentDevice({ stateDir, plugins: [x86sim({ endpoint })] });
  const scope = {
    tenant: 'x86sim',
    runId: 'ax-golden',
    leaseBackend: 'ios-instance',
    leaseProvider: 'x86sim',
  } as const;
  const lease = await host.client.leases.allocate({ ...scope, platform: 'ios', device: 'x86Sim iPhone' });
  const driver = driverFor(host.client, { ...scope, leaseId: lease.leaseId });
  return {
    driver,
    stop: async () => {
      await host.client.leases.release({ ...scope, leaseId: lease.leaseId }).catch(() => undefined);
      await host.close();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

/** Such as `iPhone 18 Pro, iOS 27.0 simulator`, from simctl. */
function describeSimulator(udid: string): string {
  const { devices } = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], { encoding: 'utf8' })) as {
    devices: Record<string, Array<{ udid: string; name: string }>>;
  };
  for (const [runtime, list] of Object.entries(devices)) {
    const device = list.find((candidate) => candidate.udid === udid);
    const version = /iOS-(\d+)-(\d+)/.exec(runtime);
    if (device) return `${device.name}, iOS ${version ? `${version[1]}.${version[2]}` : runtime} simulator`;
  }
  throw new Error(`simctl knows no simulator ${udid}`);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { udid: { type: 'string' }, screen: { type: 'string' } },
  });
  const mode = positionals[0];
  if (mode !== 'capture' && mode !== 'check') throw new Error('usage: ax-golden.ts capture --udid <udid> | check');
  if (mode === 'capture' && !values.udid) throw new Error('capture needs --udid <mac simulator udid>');
  const screens = SCREENS.filter((screen) => !values.screen || screen.name === values.screen);
  if (screens.length === 0) throw new Error(`no screen named ${values.screen}`);

  const capturedOn = mode === 'capture' ? describeSimulator(values.udid!) : '';
  const { driver, stop } = await start(mode, values.udid);
  let failed = 0;
  try {
    for (const screen of screens) {
      const lines = normalize(await visit(driver, screen));
      const fixture = await readFixture(screen.name);
      if (mode === 'capture') {
        await mkdir(FIXTURE_DIR, { recursive: true });
        const next: Fixture = {
          screen: screen.name,
          capturedOn,
          lines,
          allow: fixture?.allow ?? { missing: [], extra: [] },
        };
        await writeFile(fixturePath(screen.name), `${JSON.stringify(next, null, 2)}\n`);
        console.log(`captured ${screen.name}: ${lines.length} elements`);
        continue;
      }
      if (!fixture) throw new Error(`no fixture for ${screen.name}. Run capture on a Mac first.`);
      const diff = compare(fixture, lines);
      if (diff.length === 0) {
        console.log(`ok ${screen.name}: ${lines.length} elements`);
        continue;
      }
      failed += 1;
      console.log(`\nMISMATCH ${screen.name}, - XCTest (${fixture.capturedOn}), + x86Sim`);
      for (const { op, line } of diff) console.log(`${op} ${line}`);
    }
  } finally {
    await driver.close();
    await stop();
  }
  if (failed > 0) {
    console.log(`\n${failed} of ${screens.length} screens differ`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    const { code, message, details } = error as { code?: string; message?: string; details?: { hint?: string } };
    console.error(
      `ax-golden failed: ${code ? `${code} ` : ''}${message ?? String(error)}${details?.hint ? `\n${details.hint}` : ''}`,
    );
    process.exitCode = 2;
  });
}
