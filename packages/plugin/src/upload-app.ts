import type { WebDriverPluginOptions } from 'agent-device/plugins/webdriver';
import { appArchive } from '../../server/src/app-archive.ts';
import { APP_UPLOAD_PATH } from '../../server/src/routes.ts';

type UploadApp = NonNullable<WebDriverPluginOptions['uploadApp']>;

/**
 * `install` from another machine: the app goes to the server, which unpacks it next to x86Sim
 * and answers the path that the engine then installs.
 */
export function uploadApp(endpoint: string | URL): UploadApp {
  return async ({ appPath, signal }) => {
    const url = new URL(APP_UPLOAD_PATH.slice(1), String(endpoint).replace(/\/*$/, '/'));
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: new Uint8Array(await appArchive(appPath)),
      ...(signal ? { signal } : {}),
    });
    const body = (await response.json().catch(() => undefined)) as
      | { value?: { appPath?: unknown; error?: unknown; message?: string } }
      | undefined;
    if (response.status === 404 && body?.value?.error === 'unknown command') {
      throw new Error(
        `The x86Sim server at ${url.origin} takes no app uploads. Update agent-device-x86sim where \`serve\` runs, then start it again.`,
      );
    }
    const staged = body?.value?.appPath;
    if (!response.ok || typeof staged !== 'string') {
      throw new Error(`The x86Sim server refused the app: ${body?.value?.message ?? response.statusText}`);
    }
    return { appReference: staged };
  };
}
