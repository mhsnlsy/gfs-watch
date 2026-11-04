# İstanbul'un Havası — Android

This branch builds a native Android companion app that opens the **live GitHub Pages website** inside Capacitor.

## Live website behavior

- The Android WebView starts at `https://mhsnlsy.github.io/gfs-watch/`.
- The app therefore renders the same current HTML, styles, scripts and public data as GitHub Pages. Changes published to Pages become visible in the app without rebuilding the APK.
- The website's existing five-minute page refresh also refreshes the app while it remains open.
- The Pages service worker handles network-first navigation/data caching. On an established install, previously cached content and JSON can remain available offline. A first launch still needs internet.
- If the site cannot be reached before the service worker has cached it, Capacitor falls back to the bundled `offline.html` screen.
- The web content is loaded from a remote origin. This is the deliberate trade-off required for instant Pages mirroring; Capacitor documents `server.url` primarily for live-reload and does not recommend it as the normal production deployment pattern. This APK is distributed directly for personal use, not as a Play Store release.

## Native Android features

- Native 2×2 and 4×2 home-screen widgets.
- WorkManager refresh scheduling (15-minute periodic minimum) for widget data and rain-alert checks.
- Rain alerts for fresh MGM station observations and near-term GFS forecast precipitation.
- A native weather JSON cache used by the Android companion features.
- Forecast data continues to use the existing GFS Watch output; no extra GFS source is introduced.

## Build locally

Requirements: Node.js 22+, Android Studio with Android SDK Platform 36, and JDK 21.

```bash
npm install
npx cap add android
npm run android:prepare
npx cap sync android
npx cap open android
```

Build a debug APK:

```bash
cd android
./gradlew assembleDebug
```

## Automatic APK build

Every push to `android-capacitor` runs the Android workflow. The installable debug APK is uploaded as `istanbul-hava-debug-apk`.

## Phone test

1. Install the latest APK over the previous one. The CI keeps a stable debug signing key so updates use the same signature.
2. Open the app while online. It should display the same current page as GitHub Pages.
3. Publish a harmless visual change to Pages, then wait for deployment and the site's five-minute reload cycle or relaunch the app. The app should reflect the Pages version without an APK update.
4. Add both widgets from the Android home-screen widget picker.
5. After the first successful online load, briefly disable internet to confirm the Pages service worker's offline shell/data cache. Widgets retain their last rendered values.

## Limits

- The remote page requires internet for new uncached content; offline display is based on the Pages service worker cache.
- WorkManager runs no more often than every 15 minutes and may be deferred by Android battery management.
- Map tiles and assets from third-party services may be unavailable offline.
- Rain alert thresholds are in `WeatherData.java`: observed 1-hour precipitation ≥0.5 mm or forecast 6-hour precipitation ≥1.0 mm in the next six hours, with a six-hour repeat cooldown.
