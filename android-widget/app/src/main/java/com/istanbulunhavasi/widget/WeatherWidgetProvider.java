package com.istanbulunhavasi.widget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
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
    private static final ExecutorService EXECUTOR = Executors.newCachedThreadPool();

    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) updateOne(context, manager, id);
    }

    @Override public void onEnabled(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName cn = new ComponentName(context, WeatherWidgetProvider.class);
        for (int id : manager.getAppWidgetIds(cn)) updateOne(context, manager, id);
    }

    private void updateOne(Context context, AppWidgetManager manager, int widgetId) {
        RemoteViews loading = new RemoteViews(context.getPackageName(), R.layout.weather_widget);
        loading.setTextViewText(R.id.updated, "veri alınıyor…");
        manager.updateAppWidget(widgetId, loading);

        EXECUTOR.execute(() -> {
            JSONObject station = null, gfs = null;
            try { station = new JSONObject(fetch(STATION_URL)); } catch (Exception ignored) {}
            try { gfs = new JSONObject(fetch(GFS_URL)); } catch (Exception ignored) {}
            RemoteViews rv = buildViews(context, station, gfs);
            new Handler(Looper.getMainLooper()).post(() -> manager.updateAppWidget(widgetId, rv));
        });
    }

    private static RemoteViews buildViews(Context context, JSONObject stationDoc, JSONObject gfs) {
        RemoteViews rv = new RemoteViews(context.getPackageName(), R.layout.weather_widget);
        try {
            JSONObject s = stationDoc == null ? null : stationDoc.optJSONObject("station_observation");
            if (s != null) {
                rv.setTextViewText(R.id.station, "MGM " + s.optString("station_name", "Eyüpsultan"));
                rv.setTextViewText(R.id.temp, fmt(s.optDouble("temperature_2m_c", Double.NaN), 1) + "°");
                rv.setTextViewText(R.id.feels, "Hissedilen " + fmt(apparent(s), 1) + "°");
                String wind = fmt(s.optDouble("wind_speed_10m_kmh", Double.NaN), 0) + " km/sa " + s.optString("wind_direction_cardinal", "");
                rv.setTextViewText(R.id.details, "Rüzgâr " + wind + " · Nem " + fmt(s.optDouble("humidity_percent", Double.NaN), 0) + "%");
                rv.setTextViewText(R.id.rain_now, "Yağış " + fmt(s.optDouble("precipitation_1h_mm", Double.NaN), 1) + " mm");
                rv.setTextViewText(R.id.updated, "son ölçüm " + clock(s.optString("observed_at_utc", "")));
            } else {
                rv.setTextViewText(R.id.updated, "istasyon verisi yok");
            }

            if (gfs != null) {
                JSONArray days = gfs.optJSONArray("daily_summary");
                for (int i = 0; i < 4; i++) {
                    if (days != null && i < days.length()) {
                        JSONObject d = days.getJSONObject(i);
                        rv.setTextViewText(dateId(i), dayLabel(d.optString("date_istanbul", "")));
                        rv.setTextViewText(rainId(i), rainText(d.optDouble("precipitation_total_mm", 0)));
                        rv.setTextViewText(tempId(i), tempRange(d));
                    } else {
                        rv.setTextViewText(dateId(i), "—");
                        rv.setTextViewText(rainId(i), "☂ —");
                        rv.setTextViewText(tempId(i), "— / —");
                    }
                }
            }
        } catch (Exception e) {
            rv.setTextViewText(R.id.updated, "veri işlenemedi");
        }
        rv.setTextViewText(R.id.source, "MGM Eyüpsultan · GFS MeteoPT · 30 dk");
        return rv;
    }

    private static int dateId(int i) { return new int[]{R.id.day1_date,R.id.day2_date,R.id.day3_date,R.id.day4_date}[i]; }
    private static int rainId(int i) { return new int[]{R.id.day1_rain,R.id.day2_rain,R.id.day3_rain,R.id.day4_rain}[i]; }
    private static int tempId(int i) { return new int[]{R.id.day1_temp,R.id.day2_temp,R.id.day3_temp,R.id.day4_temp}[i]; }

    private static String fetch(String urlString) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(urlString).openConnection();
        c.setConnectTimeout(12000);
        c.setReadTimeout(18000);
        c.setRequestMethod("GET");
        c.setRequestProperty("Cache-Control", "no-cache");
        try (BufferedReader br = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
            StringBuilder out = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) out.append(line);
            return out.toString();
        } finally { c.disconnect(); }
    }

    private static double apparent(JSONObject s) {
        double t = s.optDouble("temperature_2m_c", Double.NaN);
        double rh = s.optDouble("humidity_percent", Double.NaN);
        double w = s.optDouble("wind_speed_10m_kmh", Double.NaN);
        if (Double.isNaN(t)) return Double.NaN;
        if (Double.isNaN(rh)) return t;
        double e = (rh / 100.0) * 6.105 * Math.exp(17.27 * t / (237.7 + t));
        double ln = Math.log(Math.max(e, 0.01) / 6.105);
        double td = 237.7 * ln / (17.27 - ln);
        if (t <= 10 && w > 4.8) {
            double windMs = w / 3.6;
            return 13.12 + 0.6215*t - 11.37*Math.pow(windMs, 0.16) + 0.3965*t*Math.pow(windMs,0.16);
        }
        return 0.5 * (t + td);
    }

    private static String fmt(double v, int digits) {
        if (Double.isNaN(v) || Double.isInfinite(v)) return "—";
        DecimalFormat f = new DecimalFormat(digits == 0 ? "0" : "0.0");
        return f.format(v);
    }

    private static String clock(String iso) {
        if (iso == null || iso.length() < 16) return "—";
        try {
            int h = Integer.parseInt(iso.substring(11,13)) + 3;
            if (h >= 24) h -= 24;
            return String.format(Locale.ROOT, "%02d:%s TSİ", h, iso.substring(14,16));
        } catch (Exception e) { return "—"; }
    }

    private static String dayLabel(String iso) {
        if (iso == null || iso.length() < 10) return "—";
        return iso.substring(8,10) + "/" + iso.substring(5,7);
    }

    private static String rainText(double mm) {
        return "☂ " + fmt(mm,1) + " mm";
    }

    private static String tempRange(JSONObject d) {
        return fmt(d.optDouble("temperature_max_c", Double.NaN),0) + "° / " +
               fmt(d.optDouble("temperature_min_c", Double.NaN),0) + "°";
    }
}
