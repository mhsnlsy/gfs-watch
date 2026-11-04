import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.muhsin.istanbulhava',
  appName: "İstanbul'un Havası",
  webDir: 'site',
  bundledWebRuntime: false,
  android: {
    allowMixedContent: false,
    captureInput: true
  }
};

export default config;