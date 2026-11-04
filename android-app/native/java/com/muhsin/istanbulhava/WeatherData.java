package com.muhsin.istanbulhava;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

public final class WeatherData {
    private static final String BASE_URL = "https://mhsnlsy.github.io/gfs-watch/";
    private static final String PREFS = "istanbul_weather_widget";
    private static final long SIX_HOURS_MS = 6L * 60L * 60L * 1000L;
    private static final double OBSERVED_RAIN_THRESHOLD_MM = 0.5;
    private static final double FORECAST_RAIN_THRESHOLD_MM = 1.0;

    private WeatherData() {}

    public static void refresh(Context context) throws Exception {
        JSONObject latest = fetchAndCache(context, "data/latest.json");
        if (!"gfs-watch.forecast.v1".equals(latest.optString("schema"))) {
            throw new IllegalStateException("Unexpected GFS forecast schema");
        }
        JSONArray points = latest.optJSONArray("forecast_6_hourly");
        if (points == null || points.length() == 0) {
            throw new IllegalStateException("GFS forecast timeline is empty");
        }

        JSONObject eyupsultan = fetchOptional(context, "data/eyupsultan-station-observation.json");
        JSONObject enka = fetchOptional(context, "data/station-observation.json");
        fetchOptional(context, "data/station-temperature-history.json");
        fetchOptional(context, "data/eyupsultan-station-temperature-history.json");
        fetchOptional(context, "data/ecmwf/latest.json");
        fetchOptional(context, "data/notifications/latest.json");
        fetchOptional(context, "data/forecast-verification.json");

        JSONObject station = freshStation(eyupsultan);
        if (station == null) station = freshStation(enka);
        boolean hasFreshStation = station != null;

        JSONObject conditions = latest.optJSONObject("current_conditions");
        double temperature = hasFreshStation
                ? station.optDouble("temperature_2m_c", Double.NaN)
                : conditions != null ? conditions.optDouble("temperature_2m_c", Double.NaN) : Double.NaN;
        double wind = hasFreshStation
                ? station.optDouble("wind_speed_10m_kmh", Double.NaN)
                : conditions != null ? conditions.optDouble("wind_speed_10m_kmh", Double.NaN) : Double.NaN;
        double observedRain = hasFreshStation
                ? station.optDouble("precipitation_1h_mm", Double.NaN)
                : Double.NaN;

        ForecastRain forecast = findForecastRain(points, System.currentTimeMillis());
        String runId = latest.optString("run_id_utc", "GFS");
        String runLabel = runLabel(runId);
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        SharedPreferences.Editor edit = prefs.edit();
        if (!Double.isNaN(temperature)) edit.putString("temperature", format(temperature) + "°");
        if (!Double.isNaN(wind)) edit.putString("wind", format(wind));
        edit.putString("station", hasFreshStation
                ? station.optString("station_name", "MGM istasyonu")
                : "GFS başlangıç analizi");
        edit.putString("rain_now", Double.isNaN(observedRain) ? "--" : format(observedRain));
        edit.putString("rain_forecast", forecast.maxSixHourMm < 0
                ? "--" : format(forecast.maxSixHourMm));
        edit.putString("rain_forecast_time", forecast.maxTime > 0 ? localTime(forecast.maxTime) : "");
        edit.putString("run", runLabel);
        edit.putString("run_id", runId);
        edit.putLong("updated_at", System.currentTimeMillis());
        edit.apply();

        evaluateRainAlerts(context, prefs, hasFreshStation ? station : null, forecast, latest);
        WidgetRenderer.renderAll(context);
    }

    private static JSONObject fetchAndCache(Context context, String key) throws Exception {
        String body = download(key);
        JSONObject document = new JSONObject(body);
        CacheFiles.save(context, key, body);
        return document;
    }

    private static JSONObject fetchOptional(Context context, String key) {
        try {
            String body = download(key);
            JSONObject document = new JSONObject(body);
            CacheFiles.save(context, key, body);
            return document;
        } catch (Exception ignored) {
            try {
                String cached = CacheFiles.read(context, key);
                return cached == null ? null : new JSONObject(cached);
            } catch (Exception alsoIgnored) {
                return null;
            }
        }
    }

    private static String download(String key) throws Exception {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(BASE_URL + key).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(20000);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", "IstanbulHava-Android/1.0");
            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream();
            if (stream == null || status < 200 || status >= 300) {
                throw new IllegalStateException("Weather endpoint returned HTTP " + status);
            }
            StringBuilder result = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    result.append(line);
                    if (result.length() > 8 * 1024 * 1024) {
                        throw new IllegalStateException("Weather JSON exceeds cache limit");
                    }
                }
            }
            return result.toString();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static JSONObject freshStation(JSONObject document) {
        if (document == null) return null;
        JSONObject station = document.optJSONObject("station_observation");
        if (station == null || station.optBoolean("is_stale", false)) return null;
        double age = station.optDouble("age_minutes", Double.POSITIVE_INFINITY);
        if (age > 15.0) return null;
        if (!station.has("temperature_2m_c") || !station.has("wind_speed_10m_kmh")) return null;
        return station;
    }

    private static ForecastRain findForecastRain(JSONArray points, long now) {
        ForecastRain result = new ForecastRain();
        long horizon = now + 12L * 60L * 60L * 1000L;
        long alertHorizon = now + SIX_HOURS_MS;

        for (int i = 0; i < points.length(); i++) {
            JSONObject point = points.optJSONObject(i);
            if (point == null) continue;
            long valid = parseDate(point.optString("valid_time_utc", ""));
            if (valid <= now || valid > horizon) continue;
            double amount = point.optDouble("precipitation_6h_mm", Double.NaN);
            if (Double.isNaN(amount)) continue;

            if (amount > result.maxSixHourMm) {
                result.maxSixHourMm = amount;
                result.maxTime = valid;
            }
            if (result.alertTime == 0 && valid <= alertHorizon && amount >= FORECAST_RAIN_THRESHOLD_MM) {
                result.alertTime = valid;
                result.alertAmount = amount;
            }
        }
        return result;
    }

    private static void evaluateRainAlerts(
            Context context,
            SharedPreferences prefs,
            JSONObject freshStation,
            ForecastRain forecast,
            JSONObject latest
    ) {
        if (!WeatherNotifications.canNotify(context)) return;

        long now = System.currentTimeMillis();
        boolean observedWet = false;
        double observedMm = Double.NaN;

        if (freshStation != null) {
            observedMm = freshStation.optDouble("precipitation_1h_mm", Double.NaN);
            observedWet = !Double.isNaN(observedMm) && observedMm >= OBSERVED_RAIN_THRESHOLD_MM;
        }

        if (observedWet) {
            long last = prefs.getLong("last_observed_rain_alert", 0L);
            if (now - last >= SIX_HOURS_MS) {
                String name = freshStation.optString("station_name", "MGM istasyonu");
                WeatherNotifications.show(
                        context,
                        18101,
                        "İstanbul'da yağış ölçüldü",
                        name + " istasyonunda son bir saatte " + format(observedMm) + " mm yağış kaydedildi."
                );
                prefs.edit().putLong("last_observed_rain_alert", now).apply();
            }
        }

        if (observedWet || forecast.alertTime == 0) return;
        long lastForecast = prefs.getLong("last_forecast_rain_alert", 0L);
        if (now - lastForecast < SIX_HOURS_MS) return;

        long published = parseDate(latest.optString("published_at_utc", ""));
        if (published > 0 && now - published > 12L * 60L * 60L * 1000L) return;

        String time = localTime(forecast.alertTime);
        String message = "GFS, " + time + " civarında biten 6 saatlik aralıkta yaklaşık " +
                format(forecast.alertAmount) + " mm yağış öngörüyor.";
        WeatherNotifications.show(context, 18102, "İstanbul'da yağış bekleniyor", message);
        prefs.edit().putLong("last_forecast_rain_alert", now).apply();
    }

    private static String runLabel(String runId) {
        int separator = runId.indexOf('T');
        if (separator < 0 || runId.length() < separator + 3) return "GFS";
        return runId.substring(separator + 1, Math.min(runId.length(), separator + 4)) + "Z";
    }

    private static String format(double value) {
        return String.format(Locale.forLanguageTag("tr-TR"), "%.1f", value);
    }

    private static String localTime(long time) {
        return new SimpleDateFormat("HH:mm", Locale.forLanguageTag("tr-TR")).format(new Date(time));
    }

    private static long parseDate(String value) {
        if (value == null || value.isEmpty()) return 0L;
        String[] patterns = {
                "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
                "yyyy-MM-dd'T'HH:mm:ssXXX",
                "yyyy-MM-dd'T'HH:mmXXX"
        };
        for (String pattern : patterns) {
            try {
                SimpleDateFormat parser = new SimpleDateFormat(pattern, Locale.US);
                parser.setLenient(false);
                return parser.parse(value).getTime();
            } catch (Exception ignored) {}
        }
        return 0L;
    }

    private static final class ForecastRain {
        double maxSixHourMm = -1.0;
        long maxTime = 0L;
        double alertAmount = 0.0;
        long alertTime = 0L;
    }
}