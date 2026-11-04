package com.muhsin.istanbulhava;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int NOTIFICATION_PERMISSION_REQUEST = 7104;
    private static final String LIVE_PAGES_URL = "https://mhsnlsy.github.io/gfs-watch/";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WeatherCachePlugin.class);
        super.onCreate(savedInstanceState);

        WeatherNotifications.ensureChannel(this);
        WeatherWorkScheduler.schedule(this);
        requestNotificationPermissionIfNeeded();
        forceLivePages();
    }

    @Override
    public void onStart() {
        super.onStart();
        // Capacitor's server.url is configured as well. Explicitly enforce the
        // Pages URL after Bridge initialization to avoid ever showing bundled HTML.
        forceLivePages();
    }

    private void forceLivePages() {
        getWindow().getDecorView().post(() -> {
            Bridge bridge = getBridge();
            if (bridge == null) return;
            WebView webView = bridge.getWebView();
            if (webView == null) return;
            String current = webView.getUrl();
            if (current == null || !current.startsWith("https://mhsnlsy.github.io/gfs-watch/")) {
                webView.loadUrl(LIVE_PAGES_URL);
            }
        });
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    NOTIFICATION_PERMISSION_REQUEST
            );
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST) {
            WeatherWorkScheduler.enqueueImmediate(this);
        }
    }
}
