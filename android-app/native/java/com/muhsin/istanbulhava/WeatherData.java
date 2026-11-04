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

public final class WeatherData {
    private static final String BASE_URL = "https://mhsnlsy.github.io/gfs-watch/";
    private static final String PREFS = "istanbul_weather_widget";
    private static final long SIX_HOURS_MS = 6L * 60L * 60L * 1000L;
    private static final double OBSERVED_RAIN_THRESHOLD_MM = 0.5;
    private static final double FORECAST_RAIN_THRESHOLD_MM = 1.0;

    private WeatherData() {}

    public static void refresh(Context context) throws Exception {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONObject latest;
        boolean stale = false;
        long successfulFetch = prefs.getLong("last_successful_fetch_at", 0L);
        try {
            String body = download("data/latest.json");
            latest = new JSONObject(body);
            CacheFiles.save(context, "data/latest.json", body);
            successfulFetch = System.currentTimeMillis();
        } catch (Exception networkError) {
            String cached = CacheFiles.read(context, "data/latest.json");
            if (cached == null) throw networkError;
            latest = new JSONObject(cached);
            stale = true;
        }

        if (!"gfs-watch.forecast.v1".equals(latest.optString("schema"))) {
            throw new IllegalStateException("Unexpected GFS forecast schema");
        }
        JSONArray points = latest.optJSONArray("forecast_6_hourly");
        if (points == null || points.length() == 0) {
            throw new IllegalStateException("GFS forecast timeline is empty");
        }

        JSONObject eyupsultan = fetchOptional(context, "data/eyupsultan-station-observation.json");
        JSONObject enka = fetchOptional(context, "data/station-observation.json");
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
                ? station.optDouble("precipitation_1h_mm", Double.NaN) : Double.NaN;

        long now = System.currentTimeMillis();
        ForecastRain forecast = findForecastRain(points, now);
        String runId = latest.optString("run_id_utc", "GFS");
        SharedPreferences.Editor edit = prefs.edit();
        if (!Double.isNaN(temperature)) edit.putString("temperature", format(temperature) + "°");
        if (!Double.isNaN(wind)) edit.putString("wind", format(wind));
        edit.putString("station", hasFreshStation
                ? station.optString("station_name", "İstasyon gözlemi") : "İstanbul · GFS");
        edit.putString("rain_now", Double.isNaN(observedRain) ? "--" : format(observedRain));
        edit.putString("rain_forecast", forecast.maxSixHourMm < 0 ? "--" : format(forecast.maxSixHourMm));
        edit.putString("rain_forecast_time", forecast.maxTime > 0 ? localTime(forecast.maxTime) : "");
        edit.putString("rain_24h", forecast.coveredPeriods >= 3 ? format(forecast.total24hMm) : "--");
        edit.putString("rain_detail", forecast.detail);
        edit.putString("important_message", importantMessage(forecast, observedRain));
        edit.putString("run_id", runId);
        edit.putLong("updated_at", now);
        edit.putLong("last_successful_fetch_at", successfulFetch);
        edit.putBoolean("data_stale", stale);
        edit.apply();

        evaluateRainAlerts(context, prefs, hasFreshStation ? station : null, forecast, latest);
        WidgetRenderer.renderAll(context);
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
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(18000);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", "IstanbulHava-Android/1.4.3");
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
        if (age > 15.0 || !station.has("temperature_2m_c") || !station.has("wind_speed_10m_kmh")) return null;
        return station;
    }

    private static ForecastRain findForecastRain(JSONArray points, long now) {
        ForecastRain result = new ForecastRain();
        long horizon24 = now + 24L * 60L * 60L * 1000L;
        long horizon6 = now + SIX_HOURS_MS;
        for (int i = 0; i < points.length(); i++) {
            JSONObject point = points.optJSONObject(i);
            if (point == null) continue;
            long valid = parseDate(point.optString("valid_time_utc", ""));
            if (valid <= now || valid > horizon24) continue;
            double amount = point.optDouble("precipitation_6h_mm", Double.NaN);
            if (Double.isNaN(amount) || amount < 0) continue;
            result.coveredPeriods++;
            result.total24hMm += amount;
            if (amount > result.maxSixHourMm) {
                result.maxSixHourMm = amount;
                result.maxTime = valid;
            }
            if (result.firstRainTime == 0 && amount >= FORECAST_RAIN_THRESHOLD_MM) {
                result.firstRainTime = valid;
                result.firstRainAmount = amount;
            }
            if (valid <= horizon6 && amount >= FORECAST_RAIN_THRESHOLD_MM) {
                result.rainWithin6h = true;
            }
        }
        if (result.coveredPeriods < 3) {
            result.detail = "GFS yağış tahmini için yeterli veri yok";
        } else if (result.firstRainTime > 0) {
            result.detail = "İlk yağış sinyali · " + localTime(result.firstRainTime) +
                    " civarındaki 6 saatlik dilim";
        } else if (result.total24hMm < FORECAST_RAIN_THRESHOLD_MM) {
            result.detail = "Önümüzdeki 24 saatte belirgin yağış sinyali yok";
        } else {
            result.detail = "24 saatlik yağış · " + format(result.total24hMm) + " mm";
        }
        return result;
    }

    private static String importantMessage(ForecastRain forecast, double observedRain) {
        if (!Double.isNaN(observedRain) && observedRain >= OBSERVED_RAIN_THRESHOLD_MM) {
            return "Yağış şu anda ölçülüyor · " + format(observedRain) + " mm/sa";
        }
        if (forecast.coveredPeriods < 3) return "GFS yağış tahmini için veri yetersiz";
        if (forecast.firstRainTime > 0 && forecast.rainWithin6h) {
            return "Önümüzdeki 6 saatte yağış sinyali · " + localTime(forecast.firstRainTime);
        }
        if (forecast.firstRainTime > 0) {
            return "Yağış sinyali · " + localTime(forecast.firstRainTime) + " civarındaki 6 saatlik dilim";
        }
        if (forecast.total24hMm >= FORECAST_RAIN_THRESHOLD_MM) {
            return "Önümüzdeki 24 saatte toplam " + format(forecast.total24hMm) + " mm yağış";
        }
        return "Önümüzdeki 24 saatte belirgin yağış beklenmiyor";
    }

    private static void evaluateRainAlerts(Context context, SharedPreferences prefs,
            JSONObject freshStation, ForecastRain forecast, JSONObject latest) {
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
                String name = freshStation.optString("station_name", "İstasyon");
                WeatherNotifications.show(context, 18101, "İstanbul'da yağış ölçüldü",
                        name + " istasyonunda son bir saatte " + format(observedMm) + " mm yağış kaydedildi.");
                prefs.edit().putLong("last_observed_rain_alert", now).apply();
            }
        }
        if (observedWet || !forecast.rainWithin6h) return;
        long lastForecast = prefs.getLong("last_forecast_rain_alert", 0L);
        if (now - lastForecast < SIX_HOURS_MS) return;
        long published = parseDate(latest.optString("published_at_utc", ""));
        if (published > 0 && now - published > 12L * 60L * 60L * 1000L) return;
        String message = "GFS, " + localTime(forecast.firstRainTime) +
                " civarındaki 6 saatlik dilimde " + format(forecast.firstRainAmount) + " mm yağış öngörüyor.";
        WeatherNotifications.show(context, 18102, "İstanbul'da yağış bekleniyor", message);
        prefs.edit().putLong("last_forecast_rain_alert", now).apply();
    }

    private static String format(double value) {
        return String.format(Locale.forLanguageTag("tr-TR"), "%.1f", value);
    }

    private static String localTime(long time) {
        return new SimpleDateFormat("HH:mm", Locale.forLanguageTag("tr-TR")).format(new Date(time));
    }

    private static long parseDate(String value) {
        if (value == null || value.isEmpty()) return 0L;
        String[] patterns = {"yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX", "yyyy-MM-dd'T'HH:mmXXX"};
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
        double total24hMm = 0.0;
        double firstRainAmount = 0.0;
        long maxTime = 0L;
        long firstRainTime = 0L;
        int coveredPeriods = 0;
        boolean rainWithin6h = false;
        String detail = "Yağış tahmini bekleniyor";
    }
}