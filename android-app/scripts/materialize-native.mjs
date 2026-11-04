import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const nativeRoot = join(repoRoot, 'android-app', 'native');
const androidRoot = join(repoRoot, 'android');
const appRoot = join(androidRoot, 'app');
const mainRoot = join(appRoot, 'src', 'main');
const packageName = 'com.muhsin.istanbulhava';

async function exists(path) {
  try { await readFile(path); return true; }
  catch { return false; }
}

async function walk(dir, output = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, output);
    else output.push(path);
  }
  return output;
}

if (!(await exists(join(appRoot, 'build.gradle'))) && !(await exists(join(appRoot, 'build.gradle.kts')))) {
  throw new Error('Android platform is missing. Run: npx cap add android');
}

await mkdir(mainRoot, { recursive: true });
for (const directory of ['java', 'res']) {
  await cp(join(nativeRoot, directory), join(mainRoot, directory), { recursive: true, force: true });
}

// Ensure Capacitor uses the expected native entry activity package, even if the
// CLI template changes its generated source layout.
const javaRoot = join(mainRoot, 'java');
await mkdir(join(javaRoot, ...packageName.split('.')), { recursive: true });
const mainActivity = join(javaRoot, ...packageName.split('.'), 'MainActivity.java');
const existingMainActivities = (await walk(javaRoot)).filter(path => path.endsWith('/MainActivity.java'));
for (const path of existingMainActivities) {
  if (path !== mainActivity) {
    const { rm } = await import('node:fs/promises');
    await rm(path, { force: true });
  }
}
const templateMain = join(nativeRoot, 'java', ...packageName.split('.'), 'MainActivity.java');
await writeFile(mainActivity, await readFile(templateMain, 'utf8'));

const gradleGroovy = join(appRoot, 'build.gradle');
const gradleKts = join(appRoot, 'build.gradle.kts');
if (await exists(gradleGroovy)) {
  let gradle = await readFile(gradleGroovy, 'utf8');
  if (!gradle.includes('androidx.work:work-runtime')) {
    gradle = gradle.replace(/dependencies\\s*\\{/, match =>
      match + '\\n    implementation "androidx.work:work-runtime:2.12.0"'
    );
  }
  await writeFile(gradleGroovy, gradle);
} else {
  let gradle = await readFile(gradleKts, 'utf8');
  if (!gradle.includes('androidx.work:work-runtime')) {
    gradle = gradle.replace(/dependencies\\s*\\{/, match =>
      match + '\\n    implementation("androidx.work:work-runtime:2.12.0")'
    );
  }
  await writeFile(gradleKts, gradle);
}

const manifestPath = join(mainRoot, 'AndroidManifest.xml');
let manifest = await readFile(manifestPath, 'utf8');
for (const permission of [
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECEIVE_BOOT_COMPLETED'
]) {
  if (!manifest.includes('android:name="' + permission + '"')) {
    manifest = manifest.replace('<application', '    <uses-permission android:name="' + permission + '" />\\n    <application');
  }
}

const receivers = [
  `        <receiver android:name=".WeatherWidgetProvider" android:exported="true" android:permission="android.permission.BIND_APPWIDGET">
            <intent-filter><action android:name="android.appwidget.action.APPWIDGET_UPDATE" /></intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/widget_weather_small_info" />
        </receiver>`,
  `        <receiver android:name=".WeatherWideWidgetProvider" android:exported="true" android:permission="android.permission.BIND_APPWIDGET">
            <intent-filter><action android:name="android.appwidget.action.APPWIDGET_UPDATE" /></intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/widget_weather_wide_info" />
        </receiver>`
];
for (const receiver of receivers) {
  const className = receiver.match(/android:name="([^"]+)"/)[1];
  if (!manifest.includes(className)) {
    manifest = manifest.replace('</application>', receiver + '\\n    </application>');
  }
}
await writeFile(manifestPath, manifest);

console.log('Native widget, cache, WorkManager and notification sources installed.');
