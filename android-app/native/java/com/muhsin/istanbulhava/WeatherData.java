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
        boolean forecastStale = false;
        long successfulFetch = prefs.getLong("last_successful_fetch_at", 0L);
        try {
            String body = download("data/latest.json");
            latest = new JSONObject(body);
            if (!"gfs-watch.forecast.v1".equals(latest.optString("schema"))) throw new IllegalStateException("Unexpected GFS schema");
            CacheFiles.save(context, "data/latest.json", body);
            successfulFetch = System.currentTimeMillis();
        } catch (Exception networkError) {
            String cached = CacheFiles.read(context, "data/latest.json");
            if (cached == null) throw networkError;
            latest = new JSONObject(cached);
            forecastStale = true;
        }
        if (!"gfs-watch.forecast.v1".equals(latest.optString("schema"))) throw new IllegalStateException("Unexpected GFS schema");
        JSONArray points = latest.optJSONArray("forecast_6_hourly");
        if (points == null || points.length() == 0) throw new IllegalStateException("GFS forecast timeline is empty");

        JSONObject eyupsultanDoc = fetchOptional(context, "data/eyupsultan-station-observation.json");
        JSONObject enkaDoc = fetchOptional(context, "data/station-observation.json");
        JSONObject enkaCameraDoc = fetchOptional(context, "data/station-camera-backup.json");
        JSONObject enkaForComparison = freshStation(enkaDoc, false);
        fetchOptional(context, "data/eyupsultan-station-temperature-history.json");
        JSONObject station = freshStation(eyupsultanDoc, true);
        if (station == null) station = freshStation(enkaDoc, false);
        if (station == null) station = freshStation(enkaCameraDoc, false);
        boolean live = station != null;

        JSONObject conditions = latest.optJSONObject("current_conditions");
        double temperature = live ? number(station, "temperature_2m_c")
                : conditions != null ? number(conditions, "temperature_2m_c") : Double.NaN;
        double wind = live ? number(station, "wind_speed_10m_kmh")
                : conditions != null ? number(conditions, "wind_speed_10m_kmh") : Double.NaN;
        double observedRain = live ? number(station, "precipitation_1h_mm") : Double.NaN;
        double humidity = live ? number(station, "humidity_percent") : Double.NaN;
        double pressure = live ? number(station, "station_pressure_hpa") : Double.NaN;
        double dew = live ? number(station, "dew_point_c") : Double.NaN;
        String direction = live ? station.optString("wind_direction_tr",
                station.optString("wind_direction_cardinal", "")) : "";
        long observedAt = live ? parseDate(station.optString("observed_at_utc", "")) : 0L;
        double ageMinutes = live ? Math.max(0, (System.currentTimeMillis() - observedAt) / 60000.0) : Double.NaN;
        boolean stationStale = !live || observedAt <= 0 || ageMinutes > (station.optDouble("stale_after_minutes", 30));

        long now = System.currentTimeMillis();
        ForecastRain forecast = findForecastRain(points, now);
        SharedPreferences.Editor edit = prefs.edit();
        if (!Double.isNaN(temperature)) edit.putString("temperature", format(temperature) + "°");
        edit.putString("station", live ? station.optString("station_name", "Canlı istasyon") : "GFS · Canlı istasyon bekleniyor");
        edit.putString("rain_now", Double.isNaN(observedRain) ? "--" : format(observedRain));
        edit.putString("wind", Double.isNaN(wind) ? "--" : format(wind));
        edit.putString("wind_direction", direction.isEmpty() ? "--" : direction);
        edit.putString("humidity", Double.isNaN(humidity) ? "--" : format(humidity));
        edit.putString("pressure", Double.isNaN(pressure) ? "--" : format(pressure));
        edit.putString("dew_point", Double.isNaN(dew) ? "--" : format(dew));
        edit.putString("rain_6h_observed", live && !Double.isNaN(number(station, "precipitation_6h_mm")) ? format(number(station, "precipitation_6h_mm")) : "--");
        edit.putString("rain_daily_observed", live && !Double.isNaN(number(station, "precipitation_daily_mm")) ? format(number(station, "precipitation_daily_mm")) : "--");
        edit.putString("observation_time", observedAt > 0 ? localTime(observedAt) : "");
        edit.putString("observation_age", live ? (Math.round(ageMinutes) + " dk önce") : "Canlı ölçüm yok");
        edit.putBoolean("station_stale", stationStale);
        edit.putString("rain_forecast", forecast.maxSixHourMm < 0 ? "--" : format(forecast.maxSixHourMm));
        edit.putString("rain_forecast_time", forecast.maxTime > 0 ? localTime(forecast.maxTime) : "");
        edit.putString("rain_24h", forecast.coveredPeriods >= 3 ? format(forecast.total24hMm) : "--");
        edit.putString("important_message", importantMessage(forecast, observedRain, live));
        edit.putString("run_id", latest.optString("run_id_utc", "GFS"));
        edit.putLong("updated_at", now);
        edit.putLong("last_successful_fetch_at", successfulFetch);
        edit.putBoolean("data_stale", forecastStale);
        edit.apply();

        evaluateRainAlerts(context, prefs, live && !stationStale ? station : null, forecast, latest);
        DashboardInsights.update(context, eyupsultanDoc == null ? null : eyupsultanDoc.optJSONObject("station_observation"), enkaForComparison, points, stationStale);
        WidgetRenderer.renderAll(context);
    }

    private static double number(JSONObject object, String key) {
        if (object == null || object.isNull(key)) return Double.NaN;
        double value = object.optDouble(key, Double.NaN);
        return Double.isFinite(value) ? value : Double.NaN;
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
            } catch (Exception alsoIgnored) { return null; }
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
            InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            if (stream == null || status < 200 || status >= 300) throw new IllegalStateException("Weather endpoint HTTP " + status);
            StringBuilder result = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    result.append(line);
                    if (result.length() > 8 * 1024 * 1024) throw new IllegalStateException("Weather JSON exceeds cache limit");
                }
            }
            return result.toString();
        } finally { if (connection != null) connection.disconnect(); }
    }

    private static JSONObject freshStation(JSONObject document, boolean mgm) {
        if (document == null || !"gfs-watch.station-observation.v1".equals(document.optString("schema"))) return null;
        JSONObject station = document.optJSONObject("station_observation");
        if (station == null || station.optBoolean("is_stale", false)) return null;
        long observed = parseDate(station.optString("observed_at_utc", ""));
        if (observed <= 0) return null;
        double age = Math.max(0, (System.currentTimeMillis() - observed) / 60000.0);
        double limit = mgm ? 30.0 : 15.0;
        if (age > limit || !Double.isFinite(number(station, "temperature_2m_c"))) return null;
        return station;
    }

    private static ForecastRain findForecastRain(JSONArray points, long now) {
        ForecastRain result = new ForecastRain();
        long horizon24 = now + 24L * 60L * 60L * 1000L, horizon6 = now + SIX_HOURS_MS;
        for (int i = 0; i < points.length(); i++) {
            JSONObject point = points.optJSONObject(i);
            if (point == null) continue;
            long valid = parseDate(point.optString("valid_time_utc", ""));
            if (valid <= now || valid > horizon24) continue;
            double amount = number(point, "precipitation_6h_mm");
            if (!Double.isFinite(amount) || amount < 0) continue;
            result.coveredPeriods++;
            result.total24hMm += amount;
            if (amount > result.maxSixHourMm) { result.maxSixHourMm = amount; result.maxTime = valid; }
            if (result.firstRainTime == 0 && amount >= FORECAST_RAIN_THRESHOLD_MM) {
                result.firstRainTime = valid; result.firstRainAmount = amount;
            }
            if (valid <= horizon6 && amount >= FORECAST_RAIN_THRESHOLD_MM) result.rainWithin6h = true;
        }
        return result;
    }

    private static String importantMessage(ForecastRain forecast, double observedRain, boolean live) {
        if (live && Double.isFinite(observedRain) && observedRain >= 0.1) return "Şu anda yağış ölçülüyor · " + format(observedRain) + " mm / son 1 saat";
        if (!live) return "Canlı istasyon ölçümü alınamıyor";
        if (forecast.coveredPeriods < 3) return "GFS yağış tahmini için veri yetersiz";
        if (forecast.firstRainTime > 0) return "GFS yağış sinyali · " + localTime(forecast.firstRainTime);
        if (forecast.total24hMm >= FORECAST_RAIN_THRESHOLD_MM) return "GFS · Önümüzdeki 24 saatte " + format(forecast.total24hMm) + " mm";
        return "Canlı ölçüm · Şu anda belirgin yağış yok";
    }

    private static void evaluateRainAlerts(Context context, SharedPreferences prefs, JSONObject station,
            ForecastRain forecast, JSONObject latest) {
        if (!WeatherNotifications.canNotify(context)) return;
        long now = System.currentTimeMillis();
        double observedMm = station == null ? Double.NaN : number(station, "precipitation_1h_mm");
        boolean observedWet = Double.isFinite(observedMm) && observedMm >= OBSERVED_RAIN_THRESHOLD_MM;
        if (observedWet) {
            long last = prefs.getLong("last_observed_rain_alert", 0L);
            if (now - last >= SIX_HOURS_MS) {
                WeatherNotifications.show(context, 18101, "İstanbul'da yağış ölçüldü",
                        station.optString("station_name", "İstasyon") + " · Son 1 saat: " + format(observedMm) + " mm");
                prefs.edit().putLong("last_observed_rain_alert", now).apply();
            }
        }
        if (observedWet || !forecast.rainWithin6h) return;
        long lastForecast = prefs.getLong("last_forecast_rain_alert", 0L);
        if (now - lastForecast < SIX_HOURS_MS) return;
        long published = parseDate(latest.optString("published_at_utc", ""));
        if (published > 0 && now - published > 12L * 60L * 60L * 1000L) return;
        WeatherNotifications.show(context, 18102, "İstanbul'da yağış bekleniyor",
                "GFS · " + localTime(forecast.firstRainTime) + " civarında " + format(forecast.firstRainAmount) + " mm / 6 saat");
        prefs.edit().putLong("last_forecast_rain_alert", now).apply();
    }

    private static String format(double value) { return String.format(Locale.forLanguageTag("tr-TR"), "%.1f", value); }
    private static String localTime(long time) { return new SimpleDateFormat("HH:mm", Locale.forLanguageTag("tr-TR")).format(new Date(time)); }
    private static long parseDate(String value) {
        if (value == null || value.isEmpty()) return 0L;
        String[] patterns = {"yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX", "yyyy-MM-dd'T'HH:mmXXX"};
        for (String pattern : patterns) try {
            SimpleDateFormat parser = new SimpleDateFormat(pattern, Locale.US);
            parser.setLenient(false);
            return parser.parse(value).getTime();
        } catch (Exception ignored) {}
        return 0L;
    }
    private static final class ForecastRain {
        double maxSixHourMm = -1.0, total24hMm = 0.0, firstRainAmount = 0.0;
        long maxTime = 0L, firstRainTime = 0L;
        int coveredPeriods = 0;
        boolean rainWithin6h = false;
    }
}