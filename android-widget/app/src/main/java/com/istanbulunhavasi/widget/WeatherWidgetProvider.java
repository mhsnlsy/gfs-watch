package com.istanbulunhavasi.widget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.app.PendingIntent;
import android.content.Intent;
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
import java.text.DecimalFormatSymbols;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.TextStyle;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class WeatherWidgetProvider extends AppWidgetProvider {
    private static final String STATION_URL = "https://gfs-watch-stations.muhsin-ulusoy.workers.dev/api/stations/eyupsultan";
    private static final String STATION_FALLBACK_URL = "https://istanbulunhavasi.com/api/stations/eyupsultan";
    private static final String HISTORY_URL = "https://gfs-watch-stations.muhsin-ulusoy.workers.dev/api/history/eyupsultan?hours=24";
    private static final String GFS_URL = "https://gfs-watch-web.muhsin-ulusoy.workers.dev/gfs/latest";
    private static final String GFS_FALLBACK_URL = "https://gfs-watch-istanbul-gfs.muhsin-ulusoy.workers.dev/gfs/latest";
    private static final ZoneId ISTANBUL = ZoneId.of("Europe/Istanbul");
    private static final ZoneOffset UTC = ZoneOffset.UTC;
    private static final Locale TR = Locale.forLanguageTag("tr-TR");
    private static final DateTimeFormatter UTC_TIME = DateTimeFormatter.ofPattern("HH:mm", TR).withZone(UTC);
    private static final DateTimeFormatter IST_TIME = DateTimeFormatter.ofPattern("HH:mm", TR).withZone(ISTANBUL);
    private static final DateTimeFormatter ISTANBUL_DATE = DateTimeFormatter.ofPattern("yyyy-MM-dd", TR).withZone(ISTANBUL);
    private static final DateTimeFormatter UTC_DATE = DateTimeFormatter.ofPattern("yyyy-MM-dd", TR).withZone(UTC);
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final String ACTION_REFRESH = "com.istanbulunhavasi.widget.REFRESH";

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (ACTION_REFRESH.equals(intent.getAction())) {
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            int[] ids = manager.getAppWidgetIds(new android.content.ComponentName(context, WeatherWidgetProvider.class));
            if (ids.length > 0) updateWidgets(context, manager, ids);
        }
    }

    private void updateWidgets(Context context, AppWidgetManager manager, int[] widgetIds) {
        if (widgetIds == null || widgetIds.length == 0) return;
        final int[] ids = widgetIds.clone();
        final PendingResult pending = goAsync();
        EXECUTOR.execute(() -> {
            try {
                JSONObject stationDoc = null;
                JSONObject forecastDoc = null;
                JSONObject historyDoc = null;
                try { stationDoc = fetchJson(STATION_URL, STATION_FALLBACK_URL); } catch (Exception ignored) { }
                try { forecastDoc = fetchJson(GFS_URL, GFS_FALLBACK_URL); } catch (Exception ignored) { }
                try { historyDoc = fetchJson(HISTORY_URL, null); } catch (Exception ignored) { }

                RemoteViews views = buildViews(context, stationDoc, forecastDoc, historyDoc);
                for (int id : ids) manager.updateAppWidget(id, views);
            } finally {
                pending.finish();
            }
        });
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        updateWidgets(context, manager, widgetIds);
    }

    private static RemoteViews buildViews(Context context, JSONObject stationDoc, JSONObject forecastDoc, JSONObject historyDoc) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.weather_widget);
        JSONObject station = stationObject(stationDoc);

        renderStation(views, station);
        Intent refreshIntent = new Intent(context, WeatherWidgetProvider.class).setAction(ACTION_REFRESH);
        PendingIntent refreshPending = PendingIntent.getBroadcast(
            context, 1001, refreshIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.refresh_button, refreshPending);
        views.setTextViewText(R.id.last_refresh, "Son güncelleme " + IST_TIME.format(Instant.now()));
        renderHistory(views, historyDoc);
        renderDailyTiles(views, forecastDoc);
        renderRainHours(views, forecastDoc);
        renderTemperatureTrend(views, forecastDoc, station);

        views.setTextViewText(R.id.source, "MGM Eyüpsultan · GFS MeteoPT · 30 dk");
        return views;
    }

    private static JSONObject stationObject(JSONObject document) {
        if (document == null) return null;
        JSONObject station = document.optJSONObject("station");
        if (station == null) station = document.optJSONObject("station_observation");
        if (station == null && document.has("temperature_2m_c")) station = document;
        return station;
    }

    private static void renderStation(RemoteViews views, JSONObject station) {
        if (station == null) {
            views.setTextViewText(R.id.updated, "İstasyon verisi alınamadı");
            return;
        }

        String name = station.optString("station_name", "Eyüpsultan");
        double temperature = value(station, "temperature_2m_c");
        if (Double.isNaN(temperature)) temperature = value(station, "temperature_c");
        double feels = value(station, "feels_like_c");
        double humidity = value(station, "humidity_percent");
        double wind = value(station, "wind_speed_10m_kmh");
        if (Double.isNaN(wind)) wind = value(station, "wind_speed_kmh");
        double rain = value(station, "precipitation_1h_mm");
        if (Double.isNaN(rain)) rain = value(station, "rain_1h_mm");

        views.setTextViewText(R.id.station, "MGM " + name);
        views.setTextViewText(R.id.temp, fmt(temperature, 1) + "°");
        if (Double.isNaN(feels) && !Double.isNaN(temperature)) {
            feels = apparentTemperature(temperature, humidity, wind);
        }
        views.setTextViewText(R.id.feels, "Hissedilen " + fmt(feels, 1) + "°");
        views.setTextViewText(R.id.wind_stat, fmt(wind, 1) + " km/sa" + (windDirection.isEmpty() ? "" : " · " + windDirection));
        views.setTextViewText(R.id.humidity_stat, fmt(humidity, 0) + "%");
        views.setTextViewText(R.id.rain_stat, fmt(rain, 1) + " mm");
        double dewPoint = dewPoint(temperature, humidity);
        views.setTextViewText(R.id.dew_stat, fmt(dewPoint, 1) + "°");

        String windDirection = station.optString("wind_direction_cardinal", "");
        String windText = fmt(wind, 0) + " km/sa";
        if (!windDirection.isEmpty() && !"null".equalsIgnoreCase(windDirection)) {
            windText += " " + windDirection;
        }

        String observed = station.optString("observed_at_utc", "");
        boolean stale = station.optBoolean("is_stale", false)
            || !"live".equalsIgnoreCase(station.optString("status", "live"));
        views.setTextViewText(R.id.updated,
            (stale ? "Son ölçüm · eski veri · " : "Son ölçüm · ") + displayStationTime(observed));
    }

    private static void renderHistory(RemoteViews views, JSONObject historyDoc) {
        JSONArray samples = historyDoc == null ? null : historyDoc.optJSONArray("samples");
        if (samples == null && historyDoc != null) samples = historyDoc.optJSONArray("history");
        double min = Double.NaN, max = Double.NaN, rainMax = Double.NaN;
        if (samples != null) {
            for (int i = 0; i < samples.length(); i++) {
                JSONObject item = samples.optJSONObject(i);
                if (item == null) continue;
                double temp = value(item, "temperature_2m_c");
                if (!Double.isNaN(temp)) {
                    if (Double.isNaN(min) || temp < min) min = temp;
                    if (Double.isNaN(max) || temp > max) max = temp;
                }
                double rain = value(item, "precipitation_1h_mm");
                if (Double.isNaN(rain)) rain = value(item, "rain_1h_mm");
                if (!Double.isNaN(rain) && (Double.isNaN(rainMax) || rain > rainMax)) rainMax = rain;
            }
        }
        views.setTextViewText(R.id.history_temp_badge,
            "Min " + fmt(min, 1) + "° · Maks " + fmt(max, 1) + "°");
        views.setTextViewText(R.id.history_rain_badge,
            "Maks " + fmt(rainMax, 1) + " mm");
    }

    private static void renderDailyTiles(RemoteViews views, JSONObject forecastDoc) {
        List<LocalDate> dates = forecastDays();
        JSONArray summaries = forecastDoc == null ? null : forecastDoc.optJSONArray("daily_summary");
        Map<String, JSONObject> byDate = new HashMap<>();
        if (summaries != null) {
            for (int i = 0; i < summaries.length(); i++) {
                JSONObject item = summaries.optJSONObject(i);
                if (item == null) continue;
                String key = item.optString("date_istanbul", "");
                if (!key.isEmpty()) byDate.put(key, item);
            }
        }

        Map<String, List<ForecastPoint>> localPoints = localDayPoints(forecastPoints(forecastDoc));
        int[] dateIds = dateIds();
        int[] rainIds = rainIds();
        int[] tempIds = tempIds();

        for (int i = 0; i < 5; i++) {
            LocalDate date = dates.get(i);
            String key = date.toString();
            JSONObject item = byDate.get(key);
            List<ForecastPoint> points = localPoints.get(key);
            double rain = value(item, "precipitation_total_mm");
            double max = value(item, "temperature_max_c");
            double min = value(item, "temperature_min_c");

            if (item == null && points != null && !points.isEmpty()) {
                List<Double> temps = new ArrayList<>();
                rain = 0;
                for (ForecastPoint point : points) {
                    if (!Double.isNaN(point.temperature)) temps.add(point.temperature);
                    if (!Double.isNaN(point.rain)) rain += Math.max(0, point.rain);
                }
                if (!temps.isEmpty()) {
                    max = Collections.max(temps);
                    min = Collections.min(temps);
                }
            }

            views.setTextViewText(dateIds[i], weekday(date));
            views.setTextViewText(rainIds[i], "☂ " + fmt(rain, 1) + " mm");
            views.setTextViewText(tempIds[i], fmt(max, 0) + "° / " + fmt(min, 0) + "°");
        }
    }

    private static void renderRainHours(RemoteViews views, JSONObject forecastDoc) {
        List<ForecastPoint> rows = briefingPoints(forecastDoc);
        if (rows.isEmpty()) {
            views.setTextViewText(R.id.rain_summary, "Önümüzdeki günler için tahmin noktası bulunamadı.");
            return;
        }

        List<Integer> steps = new ArrayList<>();
        Set<Integer> unique = new HashSet<>();
        for (ForecastPoint point : rows) {
            if (unique.add(point.step)) steps.add(point.step);
        }
        Collections.sort(steps);
        List<Integer> gaps = new ArrayList<>();
        for (int i = 1; i < steps.size(); i++) {
            int gap = steps.get(i) - steps.get(i - 1);
            if (gap > 0 && gap <= 6) gaps.add(gap);
        }
        Collections.sort(gaps);
        int stepHours = gaps.isEmpty() ? 3 : gaps.get(gaps.size() / 2);

        StringBuilder output = new StringBuilder();
        List<LocalDate> days = forecastDays();
        for (LocalDate date : days) {
            List<ForecastPoint> dayPoints = new ArrayList<>();
            for (ForecastPoint point : rows) {
                if (point.istanbulDate.equals(date.toString())) dayPoints.add(point);
            }
            if (dayPoints.isEmpty()) {
                double dailyRain = dailyRainFor(forecastDoc, date);
                if (!Double.isNaN(dailyRain) && dailyRain < 0.2) {
                    appendLine(output, weekday(date) + " · yağış yok");
                } else if (!Double.isNaN(dailyRain)) {
                    appendLine(output, weekday(date) + " · yağış saati ayrıntısı yok · " + fmt(dailyRain, 1) + " mm");
                }
                continue;
            }

            List<ForecastPoint> wet = new ArrayList<>();
            double daySum = 0;
            for (ForecastPoint point : dayPoints) {
                if (!Double.isNaN(point.rain) && point.rain >= 0.2) {
                    wet.add(point);
                    daySum += point.rain;
                }
            }

            List<RainSpell> spells = new ArrayList<>();
            RainSpell current = null;
            for (ForecastPoint point : wet) {
                if (current == null || point.stamp.toEpochMilli() - current.end.toEpochMilli() > stepHours * 3600000L + 60000L) {
                    current = new RainSpell(point.stamp, point.stamp, 0);
                    spells.add(current);
                }
                current.end = point.stamp;
                current.total += point.rain;
            }

            List<RainSpell> visible = new ArrayList<>();
            for (RainSpell spell : spells) {
                if (spell.total >= 0.5 || daySum < 2.0) visible.add(spell);
            }
            if (visible.isEmpty()) {
                appendLine(output, weekday(date) + " · yağış yok");
                continue;
            }

            for (RainSpell spell : visible) {
                Instant intervalEnd = spell.end.plusSeconds(stepHours * 3600L);
                String period = periodLabel(spell.start, spell.end);
                String line = weekday(date) + " · " + IST_TIME.format(spell.start) + "–" + IST_TIME.format(intervalEnd);
                if (!period.isEmpty()) line += " · " + period;
                line += " · " + fmt(spell.total, 1) + " mm";
                appendLine(output, line);
            }
        }

        if (output.length() == 0) output.append("Önümüzdeki günler için yağış saati hesaplanamadı.");
        views.setTextViewText(R.id.rain_summary, output.toString());
    }

    private static String periodLabel(Instant start, Instant end) {
        int startHour = LocalDateTime.ofInstant(start, UTC).getHour();
        int endHour = LocalDateTime.ofInstant(end, UTC).getHour();
        if (startHour >= 18 && endHour >= 18) return "akşam";
        if (startHour >= 18 && endHour <= 5) return "";
        if (endHour >= 18 && startHour < 18) return "öğleden sonra–akşam";
        if (endHour <= 5) return "";
        if (startHour >= 6 && endHour <= 11) return "sabah";
        if (startHour >= 12 && endHour <= 17) return "öğleden sonra";
        if (startHour >= 18) return "akşam";
        if (endHour < 12) return "öğleden önce";
        if (startHour >= 12) return "öğleden sonra";
        return "";
    }

    private static void renderTemperatureTrend(RemoteViews views, JSONObject forecastDoc, JSONObject station) {
        boolean stationLive = station != null
            && !station.optBoolean("is_stale", false)
            && "live".equalsIgnoreCase(station.optString("status", "live"));
        List<ForecastPoint> rows = briefingPoints(forecastDoc);
        if (!stationLive) {
            views.setTextViewText(R.id.temp_summary,
                "Eyüpsultan istasyonunun güncel ölçümü bekleniyor; eski ölçümle sıcaklık eğilimi üretilmiyor.");
            views.setTextViewText(R.id.temp_swing, swingLines(rows));
            return;
        }

        double current = value(station, "temperature_2m_c");
        if (Double.isNaN(current)) current = value(station, "temperature_c");
        List<Double> nearTemps = new ArrayList<>();
        Map<String, List<Double>> byDay = new HashMap<>();
        List<LocalDate> dayKeys = forecastDays();
        Set<String> wanted = new HashSet<>();
        for (LocalDate date : dayKeys) wanted.add(date.toString());

        long now = System.currentTimeMillis();
        for (ForecastPoint point : rows) {
            if (!Double.isNaN(point.temperature)) {
                if (point.stamp.toEpochMilli() <= now + 12 * 3600000L) nearTemps.add(point.temperature);
                if (wanted.contains(point.istanbulDate)) {
                    byDay.computeIfAbsent(point.utcDate, key -> new ArrayList<>()).add(point.temperature);
                }
            }
        }

        List<TempDay> means = new ArrayList<>();
        for (int i = 0; i < dayKeys.size(); i++) {
            LocalDate date = dayKeys.get(i);
            List<Double> values = byDay.get(date.toString());
            if (values == null || values.size() < 2) continue;
            double mean = 0;
            for (double value : values) mean += value;
            mean /= values.size();
            means.add(new TempDay(i, date, mean));
        }

        String currentText = Double.isNaN(current) ? "" : " Eyüpsultan şu an " + fmt(current, 1) + "°C.";
        if (means.size() < 3) {
            views.setTextViewText(R.id.temp_summary,
                "Önümüzdeki 5 gün için yeterli sıcaklık tahmini henüz yayımlanmadı." + currentText);
            views.setTextViewText(R.id.temp_swing, swingLines(rows));
            return;
        }

        double nearMean = current;
        if (!nearTemps.isEmpty()) {
            nearMean = 0;
            for (double value : nearTemps) nearMean += value;
            nearMean /= nearTemps.size();
        }
        if (Double.isNaN(nearMean)) nearMean = means.get(0).mean;
        double baseline = Double.isNaN(current) ? nearMean : (current + nearMean) / 2.0;

        for (int i = 0; i < means.size(); i++) {
            TempDay item = means.get(i);
            double previous = i == 0 ? baseline : means.get(i - 1).mean;
            item.delta = item.mean - previous;
            item.trend = item.delta <= -1.0 ? "fall" : item.delta >= 1.0 ? "rise" : "stable";
        }

        List<TempGroup> groups = new ArrayList<>();
        for (TempDay item : means) {
            TempGroup last = groups.isEmpty() ? null : groups.get(groups.size() - 1);
            if (last != null && last.trend.equals(item.trend)) last.days.add(item);
            else {
                TempGroup group = new TempGroup(item.trend);
                group.days.add(item);
                groups.add(group);
            }
        }

        StringBuilder summary = new StringBuilder();
        int firstFall = indexOfTrend(groups, "fall");
        if (firstFall >= 0) {
            TempDay first = groups.get(firstFall).days.get(0);
            summary.append("Hava ").append(relativeDay(first.dayIndex)).append(" (").append(weekday(first.date))
                .append(") soğumaya başlıyor; günlük ortalama yaklaşık ")
                .append(fmt(Math.abs(first.delta), 1)).append("°C düşüyor.");
            boolean laterRise = false;
            for (int i = firstFall + 1; i < groups.size(); i++) {
                TempGroup group = groups.get(i);
                if ("fall".equals(group.trend)) summary.append(" ").append(groupDays(group)).append(" günleri düşüş devam ediyor.");
                else if ("stable".equals(group.trend)) summary.append(" ").append(groupDays(group)).append(" günleri sıcaklık stabil seyrediyor.");
                else {
                    summary.append(" Yeniden ısınma ").append(weekday(group.days.get(0).date)).append(" günü başlıyor.");
                    laterRise = true;
                }
            }
            if (!laterRise) summary.append(" Beş günlük tahmin aralığında yeniden ısınma görünmüyor.");
        } else {
            int firstRise = indexOfTrend(groups, "rise");
            if (firstRise >= 0) {
                TempDay first = groups.get(firstRise).days.get(0);
                summary.append("Belirgin ısınma ").append(relativeDay(first.dayIndex)).append(" (")
                    .append(weekday(first.date)).append(") başlıyor; günlük ortalama yaklaşık ")
                    .append(fmt(Math.abs(first.delta), 1)).append("°C yükseliyor.");
                for (int i = firstRise + 1; i < groups.size(); i++) {
                    TempGroup group = groups.get(i);
                    if ("rise".equals(group.trend)) summary.append(" ").append(groupDays(group)).append(" günleri ısınma sürüyor.");
                    else if ("stable".equals(group.trend)) summary.append(" ").append(groupDays(group)).append(" günleri sıcaklık stabil seyrediyor.");
                    else summary.append(" ").append(groupDays(group)).append(" günleri sıcaklık yeniden düşüyor.");
                }
            } else {
                summary.append("Önümüzdeki beş gün boyunca sıcaklık belirgin değişim göstermeden stabil seyrediyor.");
            }
        }
        summary.append(currentText);
        views.setTextViewText(R.id.temp_summary, summary.toString());
        views.setTextViewText(R.id.temp_swing, swingLines(rows));
    }

    private static String swingLines(List<ForecastPoint> rows) {
        Map<String, List<TempSwing>> byDay = new HashMap<>();
        List<ForecastPoint> valid = new ArrayList<>();
        for (ForecastPoint point : rows) {
            if (!Double.isNaN(point.temperature)) valid.add(point);
        }
        for (int i = 1; i < valid.size(); i++) {
            ForecastPoint before = valid.get(i - 1);
            ForecastPoint after = valid.get(i);
            if (Double.isNaN(before.temperature) || Double.isNaN(after.temperature)) continue;
            double hours = (after.stamp.toEpochMilli() - before.stamp.toEpochMilli()) / 3600000.0;
            if (hours < 2.5 || hours > 3.5) continue;
            double delta = after.temperature - before.temperature;
            if (Math.abs(delta) < 4.0) continue;
            byDay.computeIfAbsent(before.istanbulDate, key -> new ArrayList<>())
                .add(new TempSwing(before.stamp, after.stamp, delta));
        }

        StringBuilder result = new StringBuilder();
        for (LocalDate date : forecastDays()) {
            List<TempSwing> swings = byDay.get(date.toString());
            if (swings == null || swings.isEmpty()) continue;
            swings.sort((a, b) -> Double.compare(Math.abs(b.delta), Math.abs(a.delta)));
            if (swings.size() > 3) swings = new ArrayList<>(swings.subList(0, 3));
            swings.sort(Comparator.comparing(a -> a.start));
            StringBuilder line = new StringBuilder(weekday(date)).append(" · ");
            for (int i = 0; i < swings.size(); i++) {
                TempSwing swing = swings.get(i);
                if (i > 0) line.append(" · ");
                line.append(IST_TIME.format(swing.start)).append("–").append(IST_TIME.format(swing.end)).append(" ")
                    .append(swing.delta < 0 ? "−" : "+").append(fmt(Math.abs(swing.delta), 1)).append("°C");
            }
            appendLine(result, line.toString());
        }
        return result.toString();
    }

    private static List<ForecastPoint> forecastPoints(JSONObject forecastDoc) {
        List<ForecastPoint> points = new ArrayList<>();
        if (forecastDoc == null) return points;
        JSONArray array = forecastDoc.optJSONArray("forecast_6_hourly");
        if (array == null) return points;

        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) continue;
            try {
                Instant stamp = Instant.parse(item.optString("valid_time_utc", ""));
                int step = item.optInt("forecast_hour", -1);
                if (step <= 0) continue;
                String utcDate = UTC_DATE.format(stamp);
                String istanbulDate = ISTANBUL_DATE.format(stamp);
                points.add(new ForecastPoint(
                    stamp,
                    step,
                    value(item, "temperature_2m_c"),
                    value(item, "precipitation_6h_mm"),
                    utcDate,
                    istanbulDate
                ));
            } catch (Exception ignored) { }
        }
        Collections.sort(points, Comparator.comparing(p -> p.stamp));
        return points;
    }

    // Mirrors the homepage briefing window: forecast steps 1–120 h, every 3 h,
    // and only the five calendar dates beginning today in Istanbul.
    private static List<ForecastPoint> briefingPoints(JSONObject forecastDoc) {
        long now = System.currentTimeMillis();
        Set<String> wanted = new HashSet<>();
        for (LocalDate date : forecastDays()) wanted.add(date.toString());
        List<ForecastPoint> result = new ArrayList<>();
        for (ForecastPoint point : forecastPoints(forecastDoc)) {
            if (point.step > 0 && point.step <= 120 && point.step % 3 == 0
                && point.stamp.toEpochMilli() >= now - 30 * 60000L
                && wanted.contains(point.istanbulDate)) {
                result.add(point);
            }
        }
        return result;
    }

    private static Map<String, List<ForecastPoint>> localDayPoints(List<ForecastPoint> points) {
        Map<String, List<ForecastPoint>> map = new HashMap<>();
        for (ForecastPoint point : points) {
            LocalDate date = point.stamp.atZone(ISTANBUL).toLocalDate();
            map.computeIfAbsent(date.toString(), key -> new ArrayList<>()).add(point);
        }
        return map;
    }

    private static double dailyRainFor(JSONObject forecastDoc, LocalDate date) {
        JSONArray days = forecastDoc == null ? null : forecastDoc.optJSONArray("daily_summary");
        if (days == null) return Double.NaN;
        for (int i = 0; i < days.length(); i++) {
            JSONObject day = days.optJSONObject(i);
            if (day != null && date.toString().equals(day.optString("date_istanbul", ""))) {
                return value(day, "precipitation_total_mm");
            }
        }
        return Double.NaN;
    }

    private static List<LocalDate> forecastDays() {
        List<LocalDate> dates = new ArrayList<>();
        LocalDate today = LocalDate.now(ISTANBUL);
        for (int i = 0; i < 5; i++) dates.add(today.plusDays(i));
        return dates;
    }

    private static int indexOfTrend(List<TempGroup> groups, String trend) {
        for (int i = 0; i < groups.size(); i++) if (trend.equals(groups.get(i).trend)) return i;
        return -1;
    }

    private static String groupDays(TempGroup group) {
        LocalDate first = group.days.get(0).date;
        LocalDate last = group.days.get(group.days.size() - 1).date;
        return first.equals(last) ? weekday(first) : weekday(first) + "–" + weekday(last);
    }

    private static String relativeDay(int offset) {
        if (offset == 0) return "bugün";
        if (offset == 1) return "yarın";
        return offset + " gün sonra";
    }

    private static String weekday(LocalDate date) {
        String value = date.getDayOfWeek().getDisplayName(TextStyle.FULL, TR);
        return value.substring(0, 1).toUpperCase(TR) + value.substring(1);
    }

    private static void appendLine(StringBuilder out, String line) {
        if (out.length() > 0) out.append("\n");
        out.append(line);
    }

    private static int[] dateIds() {
        return new int[]{R.id.day1_date, R.id.day2_date, R.id.day3_date, R.id.day4_date, R.id.day5_date};
    }
    private static int[] rainIds() {
        return new int[]{R.id.day1_rain, R.id.day2_rain, R.id.day3_rain, R.id.day4_rain, R.id.day5_rain};
    }
    private static int[] tempIds() {
        return new int[]{R.id.day1_temp, R.id.day2_temp, R.id.day3_temp, R.id.day4_temp, R.id.day5_temp};
    }

    private static JSONObject fetchJson(String primary, String fallback) throws Exception {
        Exception first = null;
        try {
            return new JSONObject(fetch(primary));
        } catch (Exception error) {
            first = error;
        }
        if (fallback != null && !fallback.equals(primary)) {
            try {
                return new JSONObject(fetch(fallback));
            } catch (Exception ignored) {
            }
        }
        throw first != null ? first : new IllegalStateException("Veri alınamadı");
    }

    private static String fetch(String urlString) throws Exception {
        URL url = new URL(urlString + (urlString.contains("?") ? "&" : "?") + "t=" + System.currentTimeMillis());
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(7000);
        connection.setReadTimeout(10000);
        connection.setRequestMethod("GET");
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Cache-Control", "no-cache");
        connection.setRequestProperty("Pragma", "no-cache");
        connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 IstanbulHavasi/1.0");
        try {
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new IllegalStateException("HTTP " + status + " · " + url.getHost());
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                StringBuilder body = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
                return body.toString();
            }
        } finally {
            connection.disconnect();
        }
    }

    private static double value(JSONObject object, String key) {
        if (object == null || object.isNull(key)) return Double.NaN;
        double result = object.optDouble(key, Double.NaN);
        return Double.isFinite(result) ? result : Double.NaN;
    }

    private static String fmt(double number, int digits) {
        if (Double.isNaN(number) || Double.isInfinite(number)) return "—";
        DecimalFormatSymbols symbols = new DecimalFormatSymbols(TR);
        DecimalFormat format = new DecimalFormat(digits == 0 ? "0" : "0.0", symbols);
        format.setGroupingUsed(false);
        return format.format(number);
    }

    private static String displayStationTime(String iso) {
        try {
            return IST_TIME.format(Instant.parse(iso)) + " TSİ";
        } catch (Exception ignored) {
            return "—";
        }
    }

    private static double dewPoint(double temp, double humidity) {
        if (humidity <= 0 || humidity > 100) return Double.NaN;
        double a = 17.27, b = 237.7;
        double alpha = Math.log(humidity / 100.0) + (a * temp) / (b + temp);
        return (b * alpha) / (a - alpha);
    }

    private static double dewPoint(double temperature, double humidity) {
        if (Double.isNaN(temperature) || Double.isNaN(humidity)) return Double.NaN;
        double gamma = Math.log(Math.max(humidity, 1.0) / 100.0)
            + (17.27 * temperature) / (237.7 + temperature);
        return (237.7 * gamma) / (17.27 - gamma);
    }

    private static double apparentTemperature(double temp, double humidity, double windKmh) {
        if (Double.isNaN(temp)) return Double.NaN;
        if (Double.isNaN(humidity)) return temp;
        double vapour = (humidity / 100.0) * 6.105 * Math.exp(17.27 * temp / (237.7 + temp));
        double logarithm = Math.log(Math.max(vapour, 0.01) / 6.105);
        double dewPoint = 237.7 * logarithm / (17.27 - logarithm);
        if (temp <= 10 && !Double.isNaN(windKmh) && windKmh > 4.8) {
            double windMs = windKmh / 3.6;
            return 13.12 + 0.6215 * temp - 11.37 * Math.pow(windMs, 0.16)
                + 0.3965 * temp * Math.pow(windMs, 0.16);
        }
        return 0.5 * (temp + dewPoint);
    }

    private static final class ForecastPoint {
        final Instant stamp;
        final int step;
        final double temperature;
        final double rain;
        final String utcDate;
        final String istanbulDate;
        ForecastPoint(Instant stamp, int step, double temperature, double rain, String utcDate, String istanbulDate) {
            this.stamp = stamp;
            this.step = step;
            this.temperature = temperature;
            this.rain = rain;
            this.utcDate = utcDate;
            this.istanbulDate = istanbulDate;
        }
    }
    private static final class RainSpell {
        final Instant start;
        Instant end;
        double total;
        RainSpell(Instant start, Instant end, double total) {
            this.start = start;
            this.end = end;
            this.total = total;
        }
    }
    private static final class TempDay {
        final int dayIndex;
        final LocalDate date;
        final double mean;
        double delta;
        String trend;
        TempDay(int dayIndex, LocalDate date, double mean) {
            this.dayIndex = dayIndex;
            this.date = date;
            this.mean = mean;
        }
    }
    private static final class TempGroup {
        final String trend;
        final List<TempDay> days = new ArrayList<>();
        TempGroup(String trend) { this.trend = trend; }
    }
    private static final class TempSwing {
        final Instant start;
        final Instant end;
        final double delta;
        TempSwing(Instant start, Instant end, double delta) {
            this.start = start;
            this.end = end;
            this.delta = delta;
        }
    }
}