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
import java.util.ArrayList;
import java.util.List;
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
                        rv.setTextViewText(rainId(i), "Yağış " + fmt(d.optDouble("precipitation_total_mm", 0),1) + " mm");
                        rv.setTextViewText(tempId(i), tempRange(d));
                    } else {
                        rv.setTextViewText(dateId(i), "—");
                        rv.setTextViewText(rainId(i), "Yağış —");
                        rv.setTextViewText(tempId(i), "— / —");
                    }
                }
                renderRainSummary(rv, gfs);
                renderTemperatureSummary(rv, gfs, stationDoc);
            }
        } catch (Exception e) {
            rv.setTextViewText(R.id.updated, "veri işlenemedi");
        }
        rv.setTextViewText(R.id.source, "MGM Eyüpsultan · GFS MeteoPT · 30 dk");
        return rv;
    }

    private static void renderRainSummary(RemoteViews rv, JSONObject gfs) {
        JSONArray points = gfs.optJSONArray("forecast_6_hourly");
        if (points == null || points.length() == 0) {
            rv.setTextViewText(R.id.rain_summary, "Önümüzdeki günler için çıktı yok.");
            return;
        }
        StringBuilder out = new StringBuilder();
        String lastDay = "";
        boolean wrote = false;
        for (int i=0; i<points.length(); i++) {
            JSONObject p=points.optJSONObject(i);
            if(p==null)continue;
            double mm=p.optDouble("precipitation_6h_mm",0);
            if(mm<0.2)continue;
            String date=p.optString("valid_time_istanbul_date",p.optString("date_istanbul",""));
            String clock=p.optString("valid_time_istanbul","");
            if(clock.length()>=5)clock=clock.substring(0,5);
            if(!date.equals(lastDay)){
                if(wrote)out.append("\n");
                out.append(dayName(date)).append(" · ");
                lastDay=date;
            }else out.append(" · ");
            out.append(clock).append("–").append(endClock(clock,6)).append(" · ").append(fmt(mm,1)).append(" mm");
            wrote=true;
        }
        if(!wrote){
            JSONArray days=gfs.optJSONArray("daily_summary");
            if(days!=null){
                for(int i=0;i<Math.min(5,days.length());i++){
                    JSONObject d=days.optJSONObject(i);
                    if(i>0)out.append("\n");
                    out.append(dayName(d.optString("date_istanbul",""))).append(" · yağış yok");
                }
            }else out.append("Önümüzdeki günlerde yağış görünmüyor.");
        }
        rv.setTextViewText(R.id.rain_summary,out.toString());
    }

    private static void renderTemperatureSummary(RemoteViews rv, JSONObject gfs, JSONObject stationDoc) {
        JSONArray points=gfs.optJSONArray("forecast_6_hourly");
        if(points==null||points.length()<3){
            rv.setTextViewText(R.id.temp_summary,"Beş günlük sıcaklık eğilimi için yeterli veri yok.");
            return;
        }
        double current=Double.NaN;
        JSONObject s=stationDoc==null?null:stationDoc.optJSONObject("station_observation");
        if(s!=null)current=s.optDouble("temperature_2m_c",Double.NaN);

        List<Double> means=new ArrayList<>();
        List<String> dates=new ArrayList<>();
        String lastDate=""; double sum=0; int count=0;
        for(int i=0;i<points.length();i++){
            JSONObject p=points.optJSONObject(i); if(p==null)continue;
            String date=p.optString("valid_time_istanbul_date",p.optString("date_istanbul",""));
            double t=p.optDouble("temperature_2m_c",Double.NaN);
            if(date.length()==0||Double.isNaN(t))continue;
            if(!date.equals(lastDate)&&count>0){
                means.add(sum/count); dates.add(lastDate); sum=0; count=0;
            }
            lastDate=date; sum+=t; count++;
            if(means.size()>=5)break;
        }
        if(count>0&&means.size()<5){means.add(sum/count);dates.add(lastDate);}
        if(means.size()<3){
            rv.setTextViewText(R.id.temp_summary,"Beş günlük sıcaklık eğilimi için yeterli veri yok.");
            return;
        }
        int firstFall=-1;
        for(int i=0;i<means.size();i++){
            double prev=i==0?(Double.isNaN(current)?means.get(0):current):means.get(i-1);
            if(means.get(i)-prev<=-1.0){firstFall=i;break;}
        }
        StringBuilder summary=new StringBuilder();
        if(firstFall>=0){
            String when=firstFall==0?"bugün":firstFall==1?"yarın":firstFall+" gün sonra";
            double delta=means.get(firstFall)-(firstFall==0?(Double.isNaN(current)?means.get(0):current):means.get(firstFall-1));
            summary.append("Hava ").append(when).append(" (").append(dayName(dates.get(firstFall))).append(") soğumaya başlıyor; günlük ortalama yaklaşık ").append(fmt(Math.abs(delta),1)).append("°C düşüyor.");
            boolean rise=false;
            for(int i=firstFall+1;i<means.size();i++) if(means.get(i)-means.get(i-1)>=1.0){rise=true;break;}
            if(!rise)summary.append(" Beş günlük tahmin aralığında yeniden ısınma görünmüyor.");
            else summary.append(" Tahminin ilerleyen bölümünde yeniden ısınma sinyali var.");
        }else{
            boolean rise=false;
            for(int i=1;i<means.size();i++)if(means.get(i)-means.get(i-1)>=1.0){rise=true;break;}
            summary.append(rise?"Belirgin ısınma başlıyor.":"Önümüzdeki beş gün boyunca sıcaklık belirgin değişim göstermeden stabil seyrediyor.");
        }
        if(!Double.isNaN(current))summary.append(" Eyüpsultan şu an ").append(fmt(current,1)).append("°C.");
        rv.setTextViewText(R.id.temp_summary,summary.toString());
        rv.setTextViewText(R.id.temp_swing,firstLargeSwing(points));
    }

    private static String firstLargeSwing(JSONArray points){
        JSONObject prev=null;
        for(int i=0;i<points.length();i++){
            JSONObject p=points.optJSONObject(i); if(p==null)continue;
            double t=p.optDouble("temperature_2m_c",Double.NaN);
            if(prev!=null){
                double pt=prev.optDouble("temperature_2m_c",Double.NaN);
                if(!Double.isNaN(t)&&!Double.isNaN(pt)){
                    double delta=t-pt;
                    if(Math.abs(delta)>=4.0){
                        String date=prev.optString("valid_time_istanbul_date",prev.optString("date_istanbul",""));
                        String a=prev.optString("valid_time_istanbul",""),b=p.optString("valid_time_istanbul","");
                        if(a.length()>=5)a=a.substring(0,5); if(b.length()>=5)b=b.substring(0,5);
                        return dayName(date)+" · "+a+"–"+b+" "+(delta<0?"−":"+")+fmt(Math.abs(delta),1)+"°C";
                    }
                }
            }
            prev=p;
        }
        return "";
    }

    private static String endClock(String clock,int hours){
        try{int h=Integer.parseInt(clock.substring(0,2)); h=(h+hours)%24; return String.format(Locale.ROOT,"%02d:%s",h,clock.substring(3,5));}
        catch(Exception e){return clock;}
    }

    private static String dayName(String date){
        if(date==null||date.length()<10)return "—";
        try{
            int y=Integer.parseInt(date.substring(0,4)),m=Integer.parseInt(date.substring(5,7)),d=Integer.parseInt(date.substring(8,10));
            java.util.Calendar c=java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("Europe/Istanbul"),Locale.forLanguageTag("tr-TR"));
            c.set(y,m-1,d,12,0,0);
            String s=new java.text.SimpleDateFormat("EEEE",Locale.forLanguageTag("tr-TR")).format(c.getTime());
            return s.substring(0,1).toUpperCase(Locale.forLanguageTag("tr-TR"))+s.substring(1);
        }catch(Exception e){return date.substring(8,10)+"/"+date.substring(5,7);}
    }

    private static int dateId(int i){return new int[]{R.id.day1_date,R.id.day2_date,R.id.day3_date,R.id.day4_date}[i];}
    private static int rainId(int i){return new int[]{R.id.day1_rain,R.id.day2_rain,R.id.day3_rain,R.id.day4_rain}[i];}

    private static int tempId(int i){return new int[]{R.id.day1_temp,R.id.day2_temp,R.id.day3_temp,R.id.day4_temp}[i];}
    private static String fetch(String urlString)throws Exception{
        HttpURLConnection c=(HttpURLConnection)new URL(urlString).openConnection();
        c.setConnectTimeout(12000); c.setReadTimeout(18000); c.setRequestMethod("GET"); c.setRequestProperty("Cache-Control","no-cache");
        try(BufferedReader br=new BufferedReader(new InputStreamReader(c.getInputStream(),StandardCharsets.UTF_8))){
            StringBuilder out=new StringBuilder(); String line; while((line=br.readLine())!=null)out.append(line); return out.toString();
        }finally{c.disconnect();}
    }
    private static double apparent(JSONObject s){
        double t=s.optDouble("temperature_2m_c",Double.NaN),rh=s.optDouble("humidity_percent",Double.NaN),w=s.optDouble("wind_speed_10m_kmh",Double.NaN);
        if(Double.isNaN(t))return Double.NaN; if(Double.isNaN(rh))return t;
        double e=(rh/100.0)*6.105*Math.exp(17.27*t/(237.7+t)),ln=Math.log(Math.max(e,0.01)/6.105),td=237.7*ln/(17.27-ln);
        if(t<=10&&w>4.8){double ms=w/3.6; return 13.12+0.6215*t-11.37*Math.pow(ms,0.16)+0.3965*t*Math.pow(ms,0.16);}
        return 0.5*(t+td);
    }
    private static String fmt(double v,int digits){
        if(Double.isNaN(v)||Double.isInfinite(v))return "—";
        DecimalFormat f=new DecimalFormat(digits==0?"0":"0.0"); return f.format(v);
    }
    private static String clock(String iso){
        if(iso==null||iso.length()<16)return "—";
        try{int h=Integer.parseInt(iso.substring(11,13))+3;if(h>=24)h-=24;return String.format(Locale.ROOT,"%02d:%s TSİ",h,iso.substring(14,16));}
        catch(Exception e){return "—";}
    }
    private static String dayLabel(String iso){if(iso==null||iso.length()<10)return "—";return iso.substring(8,10)+"/"+iso.substring(5,7);}
    private static String tempRange(JSONObject d){return fmt(d.optDouble("temperature_max_c",Double.NaN),0)+"° / "+fmt(d.optDouble("temperature_min_c",Double.NaN),0)+"°";}
}