import type { WebDriverPluginOptions } from 'agent-device/plugins/webdriver';

/**
 * What x86Sim does with each cloud provider profile field. The record is total over the
 * installed `CloudProviderProfileFields` keys, so a field added upstream fails the build here
 * until it is answered. x86Sim is a local simulator, not a cloud: it reads none of them.
 */
export const X86SIM_PROFILE_FIELDS: WebDriverPluginOptions['profileFields'] = {
  provider: 'x86sim',
  label: 'x86Sim',
  fields: {
    providerApp: 'refused',
    providerOsVersion: 'refused',
    providerDeviceType: 'refused',
    providerProject: 'refused',
    providerBuild: 'refused',
    providerSessionName: 'refused',
    providerDeviceOrientation: 'refused',
    providerGeoLocation: 'refused',
    providerTimezone: 'refused',
    providerAppiumVersion: 'refused',
    providerLanguage: 'refused',
    providerLocale: 'refused',
    providerNetworkProfile: 'refused',
    providerCustomNetwork: 'refused',
    providerNoResignApp: 'refused',
    providerNetworkLogs: 'refused',
    providerNetworkHosts: 'refused',
    awsProjectArn: 'refused',
    awsDeviceArn: 'refused',
    awsAppArn: 'refused',
    awsRegion: 'refused',
    awsInteractionMode: 'refused',
  },
};
