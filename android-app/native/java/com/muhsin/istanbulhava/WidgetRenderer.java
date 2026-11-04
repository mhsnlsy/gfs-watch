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
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        RemoteViews v = new RemoteViews(context.getPackageName(), wide ? R.layout.widget_weather_wide : R.layout.widget_weather_small);
        String temp=p.getString("temperature","--°"), station=p.getString("station","Canlı gözlem bekleniyor");
        String rain=p.getString("rain_now","--"), wind=p.getString("wind","--"), dir=p.getString("wind_direction","--");
        String humidity=p.getString("humidity","--"), pressure=p.getString("pressure","--"), dew=p.getString("dew_point","--");
        String rain6=p.getString("rain_6h_observed","--"), daily=p.getString("rain_daily_observed","--");
        String message=p.getString("important_message","Canlı gözlem bekleniyor");
        String age=p.getString("observation_age","Ölçüm zamanı yok");
        boolean stationStale=p.getBoolean("station_stale",true), forecastStale=p.getBoolean("data_stale",false);
        long observed=p.getLong("last_successful_fetch_at",0L);
        v.setTextViewText(R.id.widget_source,station+(stationStale?" · ESKİ":" · CANLI"));
        v.setTextViewText(R.id.widget_temperature,temp);
        String updated=observed>0?new SimpleDateFormat("HH:mm",Locale.forLanguageTag("tr-TR")).format(new Date(observed)):"--:--";
        v.setTextViewText(R.id.widget_updated,(stationStale?"SON GÖZLEM · ":"ÖLÇÜM · ")+age+" · "+updated+(forecastStale?" · GFS önbellek":""));
        if(wide){
            v.setTextViewText(R.id.widget_model,"CANLI İSTASYON GÖZLEMİ");
            v.setTextViewText(R.id.widget_rain_forecast,message);
            v.setTextViewText(R.id.widget_rain_now,"Yağış · "+rain+" mm/1s  |  Nem · "+humidity+"%");
            v.setTextViewText(R.id.widget_wind,"Rüzgâr · "+wind+" km/sa "+dir+"  |  Basınç · "+pressure+" hPa");
        }else{
            v.setTextViewText(R.id.widget_detail,"Yağış "+rain+" mm/1s · Nem "+humidity+"%");
            v.setTextViewText(R.id.widget_extra,"Rüzgâr "+wind+" km/sa "+dir+" · Basınç "+pressure+" hPa");
        }
        Intent open=new Intent(context,MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending=PendingIntent.getActivity(context,wide?4202:2202,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        v.setOnClickPendingIntent(R.id.widget_root,pending);
        return v;
    }
}