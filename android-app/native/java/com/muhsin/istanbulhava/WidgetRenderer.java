package com.muhsin.istanbulhava;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public final class WidgetRenderer {
    private static final String PREFS = "istanbul_weather_widget";

    private WidgetRenderer() {}

    public static void renderAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName small = new ComponentName(context, WeatherWidgetProvider.class);
        ComponentName wide = new ComponentName(context, WeatherWideWidgetProvider.class);
        updateSmall(context, manager, manager.getAppWidgetIds(small));
        updateWide(context, manager, manager.getAppWidgetIds(wide));
    }

    public static void updateSmall(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) {
            manager.updateAppWidget(id, build(context, false));
        }
    }

    public static void updateWide(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) {
            manager.updateAppWidget(id, build(context, true));
        }
    }

    private static RemoteViews build(Context context, boolean wide) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int layout = wide ? R.layout.widget_weather_wide : R.layout.widget_weather_small;
        RemoteViews views = new RemoteViews(context.getPackageName(), layout);

        String temp = prefs.getString("temperature", "--");
        String source = prefs.getString("station", "Son veri bekleniyor");
        String wind = prefs.getString("wind", "--");
        String rainNow = prefs.getString("rain_now", "--");
        String rainForecast = prefs.getString("rain_forecast", "--");
        String forecastTime = prefs.getString("rain_forecast_time", "");
        String run = prefs.getString("run", "GFS");
        long updated = prefs.getLong("updated_at", 0L);

        views.setTextViewText(R.id.widget_temperature, temp);
        views.setTextViewText(R.id.widget_source, source);
        views.setTextViewText(R.id.widget_updated, updated > 0
                ? "Güncelleme " + new SimpleDateFormat("HH:mm", Locale.forLanguageTag("tr-TR")).format(new Date(updated))
                : "İnternet bağlantısı bekleniyor");

        if (wide) {
            views.setTextViewText(R.id.widget_wind, "Rüzgâr  " + wind + " km/sa");
            views.setTextViewText(R.id.widget_rain_now, "Ölçülen yağış  " + rainNow + " mm/sa");
            String rainLine = rainForecast.equals("--")
                    ? "Yağış tahmini bekleniyor"
                    : "En yüksek 6 saatlik yağış  " + rainForecast + " mm";
            if (!forecastTime.isEmpty()) rainLine += " · " + forecastTime;
            views.setTextViewText(R.id.widget_rain_forecast, rainLine);
            views.setTextViewText(R.id.widget_model, run + " · GFS");
        } else {
            String detail = "Yağış " + rainForecast + " mm/6s  ·  Rüzgâr " + wind;
            views.setTextViewText(R.id.widget_detail, detail);
        }

        Intent open = new Intent(context, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(
                context,
                wide ? 4202 : 2202,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.widget_root, pending);
        return views;
    }
}