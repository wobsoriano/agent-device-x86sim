import type { AgentDevicePlugin, ProviderPluginHost } from 'agent-device/plugins';
import { X86SIM_PROFILE_FIELDS } from './profile-fields.ts';

type Connection = NonNullable<AgentDevicePlugin['connection']>;

export const PROVIDER = 'x86sim';
export const SERVICE = 'x86Sim';
export const DEFAULT_DEVICE = 'x86Sim iPhone';
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:4723';

const STATUS_TIMEOUT_MS = 5_000;

/** Options win over the environment, and the environment wins over the local default. */
export function resolveEndpoint(endpoint: string | undefined, env: ProviderPluginHost['env']): string {
  return endpoint ?? env.X86SIM_WEBDRIVER_ENDPOINT ?? DEFAULT_ENDPOINT;
}

/** `connect x86sim` takes no provider flags, so a set one is a mistake worth naming. */
function rejectProviderFlags(flags: object, host: ProviderPluginHost): void {
  const set = Object.keys(X86SIM_PROFILE_FIELDS.fields).filter(
    (key) => (flags as Record<string, unknown>)[key] !== undefined,
  );
  if (set.length > 0) {
    throw host.createError('INVALID_ARGS', `${SERVICE} does not use these provider flags: ${set.join(', ')}.`);
  }
}

export function createConnection(options: { endpoint?: string | undefined }): Connection {
  return {
    capabilities: {
      leaseKind: 'direct-device-provider',
      requiresAppAttachment: false,
      requiresRemoteDaemon: false,
      supportsArtifacts: false,
      supportsDeferredAppSelection: true,
      supportsDirectPortReverse: false,
      usesCloudWebDriverLease: true,
    },
    resolve: ({ flags, host }) => {
      rejectProviderFlags(flags, host);
      return {
        profile: {
          leaseProvider: PROVIDER,
          platform: 'ios',
          device: flags.device ?? DEFAULT_DEVICE,
        },
      };
    },
    verify: async ({ flags, env, host }) => {
      const endpoint = resolveEndpoint(options.endpoint, env);
      const statusUrl = new URL('status', endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
      let ready: unknown;
      try {
        const response = await fetch(statusUrl, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
        const body = (await response.json()) as { value?: { ready?: unknown } };
        ready = response.ok ? body.value?.ready : undefined;
      } catch (error) {
        throw host.createError('COMMAND_FAILED', `${SERVICE} WebDriver server is not reachable at ${statusUrl.href}.`, {
          cause: String(error),
        });
      }
      if (ready !== true) {
        throw host.createError(
          'COMMAND_FAILED',
          `${SERVICE} WebDriver server at ${statusUrl.href} did not report ready.`,
        );
      }
      return {
        provider: PROVIDER,
        service: SERVICE,
        verificationMessage: `${SERVICE} WebDriver server is ready at ${endpoint}.`,
        device: {
          status: 'verified',
          name: flags.device ?? DEFAULT_DEVICE,
          platform: 'ios',
        },
        app: { status: 'deferred' },
      };
    },
  };
}
