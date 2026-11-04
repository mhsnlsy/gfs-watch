package com.muhsin.istanbulhava;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
public class WeatherDashboardWidgetProvider extends AppWidgetProvider {
 @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
  WidgetRenderer.updateDashboard(context, manager, ids);
  WeatherWorkScheduler.enqueueImmediate(context);
 }
 @Override public void onEnabled(Context context) { WeatherWorkScheduler.schedule(context); }
}