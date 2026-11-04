package com.muhsin.istanbulhava;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;

public class WeatherWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        WidgetRenderer.updateSmall(context, manager, appWidgetIds);
        WeatherWorkScheduler.enqueueImmediate(context);
    }

    @Override
    public void onEnabled(Context context) {
        WeatherWorkScheduler.schedule(context);
    }
}