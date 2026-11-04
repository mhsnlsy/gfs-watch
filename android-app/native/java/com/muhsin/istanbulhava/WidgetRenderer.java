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
        updateSmall(context, manager, manager.getAppWidgetIds(new ComponentName(context, WeatherWidgetProvider.class)));
        updateWide(context, manager, manager.getAppWidgetIds(new ComponentName(context, WeatherWideWidgetProvider.class)));
    }

    public static void updateSmall(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) manager.updateAppWidget(id, build(context, false));
    }

    public static void updateWide(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) manager.updateAppWidget(id, build(context, true));
    }

    private static RemoteViews build(Context context, boolean wide) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        RemoteViews views = new RemoteViews(context.getPackageName(),
                wide ? R.layout.widget_weather_wide : R.layout.widget_weather_small);

        String temp = prefs.getString("temperature", "--");
        String station = prefs.getString("station", "İstanbul · GFS");
        String wind = prefs.getString("wind", "--");
        String message = prefs.getString("important_message", "GFS tahmini bekleniyor");
        String rainDetail = prefs.getString("rain_detail", "Yağış tahmini bekleniyor");
        String observed = prefs.getString("rain_now", "--");
        String forecast24 = prefs.getString("rain_24h", "--");
        long updated = prefs.getLong("updated_at", 0L);
        boolean stale = prefs.getBoolean("data_stale", false);
        long successfulAt = prefs.getLong("last_successful_fetch_at", updated);

        views.setTextViewText(R.id.widget_temperature, temp);
        views.setTextViewText(R.id.widget_source, station);
        String updateText = successfulAt > 0
                ? (stale ? "SON BAŞARILI VERİ · " : "Güncel · ") +
                    new SimpleDateFormat("HH:mm", Locale.forLanguageTag("tr-TR")).format(new Date(successfulAt))
                : "Veri bağlantısı bekleniyor";
        views.setTextViewText(R.id.widget_updated, updateText);

        if (wide) {
            views.setTextViewText(R.id.widget_model, "GFS · İSTANBUL");
            views.setTextViewText(R.id.widget_rain_forecast, message);
            views.setTextViewText(R.id.widget_rain_now, "Ölçülen yağış · " + observed + " mm/sa");
            views.setTextViewText(R.id.widget_wind, "Rüzgâr · " + wind + " km/sa  |  24 sa · " + forecast24 + " mm");
        } else {
            views.setTextViewText(R.id.widget_detail, message);
        }

        Intent open = new Intent(context, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(context, wide ? 4202 : 2202, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_root, pending);
        return views;
    }
}