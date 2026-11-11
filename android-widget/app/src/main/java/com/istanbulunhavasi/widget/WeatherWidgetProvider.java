package com.istanbulunhavasi.widget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.os.Bundle;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.DecimalFormat;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class WeatherWidgetProvider extends AppWidgetProvider {
    private static final String STATION_URL = "https://istanbulunhavasi.com/api/stations/eyupsultan";
    private static final String GFS_URL = "https://gfs-watch-istanbul-gfs.muhsin-ulusoy.workers.dev/gfs/latest";
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) {
            manager.updateAppWidget(id, baseViews(context));
            fetchAndUpdate(context, manager, id);
        }
    }

    @Override public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int id, Bundle options) {
        manager.updateAppWidget(id, baseViews(context));
        fetchAndUpdate(context, manager, id);
    }

    private static RemoteViews baseViews(Context context) {
        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget);
        v.setTextViewText(R.id.updated, "veri alınıyor…");
        return v;
    }

    private static void fetchAndUpdate(Context context, AppWidgetManager manager, int id) {
        EXECUTOR.execute(() -> {
            JSONObject station = null;
            JSONObject gfs = null;
            try { station = new JSONObject(get(STATION_URL)); } catch (Exception ignored) {}
            try { gfs = new JSONObject(get(GFS_URL)); } catch (Exception ignored) {}

            RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget);

            try {
                JSONObject s = station == null ? null : station.optJSONObject("station_observation");
                if (s != null) {
                    v.setTextViewText(R.id.station, "MGM " + s.optString("station_name", "Eyüpsultan"));
                    v.setTextViewText(R.id.temp, one(s.optDouble("temperature_2m_c", Double.NaN)) + "°");
                    v.setTextViewText(R.id.feels, "Hissedilen " + one(apparent(s)) + "°");
                    v.setTextViewText(R.id.details, "Rüzgâr " + zero(s.optDouble("wind_speed_10m_kmh", Double.NaN)) + " km/sa " +
                            s.optString("wind_direction_cardinal", "") + " · Nem " + zero(s.optDouble("humidity_percent", Double.NaN)) + "%");
                    v.setTextViewText(R.id.rain_now, "Yağış " + one(s.optDouble("precipitation_1h_mm", Double.NaN)) + " mm");
                    v.setTextViewText(R.id.updated, "Son ölçüm " + localTime(s.optString("observed_at_utc", "")));
                } else {
                    v.setTextViewText(R.id.updated, "İstasyon verisi alınamadı");
                }

                if (gfs != null) {
                    JSONArray days = gfs.optJSONArray("daily_summary");
                    int[] date = {R.id.day1_date,R.id.day2_date,R.id.day3_date,R.id.day4_date};
                    int[] rain = {R.id.day1_rain,R.id.day2_rain,R.id.day3_rain,R.id.day4_rain};
                    int[] temp = {R.id.day1_temp,R.id.day2_temp,R.id.day3_temp,R.id.day4_temp};
                    for (int i=0; i<4; i++) {
                        if (days != null && i < days.length()) {
                            JSONObject d = days.getJSONObject(i);
                            v.setTextViewText(date[i], shortDate(d.optString("date_istanbul","")));
                            v.setTextViewText(rain[i], "Yağış " + one(d.optDouble("precipitation_total_mm",0)) + " mm");
                            v.setTextViewText(temp[i], zero(d.optDouble("temperature_max_c",Double.NaN)) + "° / " +
                                    zero(d.optDouble("temperature_min_c",Double.NaN)) + "°");
                        }
                    }
                }
            } catch (Exception e) {
                v.setTextViewText(R.id.updated, "Veri işlenemedi");
            }

            v.setTextViewText(R.id.source, "MGM Eyüpsultan · GFS · 30 dk");
            manager.updateAppWidget(id, v);
        });
    }

    private static String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection)new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        c.setRequestMethod("GET");
        c.setUseCaches(false);
        try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
            StringBuilder b = new StringBuilder();
            String line;
            while ((line=r.readLine()) != null) b.append(line);
            return b.toString();
        } finally { c.disconnect(); }
    }

    private static String one(double x) {
        if (Double.isNaN(x) || Double.isInfinite(x)) return "—";
        return new DecimalFormat("0.0").format(x);
    }
    private static String zero(double x) {
        if (Double.isNaN(x) || Double.isInfinite(x)) return "—";
        return new DecimalFormat("0").format(x);
    }
    private static double apparent(JSONObject s) {
        double t=s.optDouble("temperature_2m_c",Double.NaN);
        double rh=s.optDouble("humidity_percent",Double.NaN);
        if (Double.isNaN(t) || Double.isNaN(rh)) return t;
        double w=s.optDouble("wind_speed_10m_kmh",0);
        double e=(rh/100.0)*6.105*Math.exp(17.27*t/(237.7+t));
        double ln=Math.log(Math.max(e,0.01)/6.105);
        double td=237.7*ln/(17.27-ln);
        if (t<=10 && w>4.8) {
            double ms=w/3.6;
            return 13.12+0.6215*t-11.37*Math.pow(ms,0.16)+0.3965*t*Math.pow(ms,0.16);
        }
        return 0.5*(t+td);
    }
    private static String localTime(String iso) {
        if (iso == null || iso.length()<16) return "—";
        try {
            int h=Integer.parseInt(iso.substring(11,13))+3; if(h>=24)h-=24;
            return String.format(Locale.ROOT,"%02d:%s TSİ",h,iso.substring(14,16));
        } catch(Exception e){return "—";}
    }
    private static String shortDate(String iso) {
        if (iso==null || iso.length()<10) return "—";
        return iso.substring(8,10)+"."+iso.substring(5,7);
    }
}
