package com.muhsin.istanbulhava;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class WidgetRefreshReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        WidgetRenderer.renderAll(context);
        WeatherWorkScheduler.enqueueImmediate(context);
    }
}