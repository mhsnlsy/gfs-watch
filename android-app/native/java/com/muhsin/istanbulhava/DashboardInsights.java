package com.muhsin.istanbulhava;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

final class DashboardInsights {
 private DashboardInsights(){}
 static void update(Context c, JSONObject eyup, JSONObject enka, JSONArray forecast, boolean stale) {
  SharedPreferences p=c.getSharedPreferences("istanbul_weather_widget",Context.MODE_PRIVATE);
  SharedPreferences.Editor e=p.edit();
  double current=val(eyup,"temperature_2m_c"), balm=val(enka,"temperature_2m_c");
  String cmp="Sıcaklık karşılaştırması için veri yetersiz";
  if(Double.isFinite(current)){
   JSONArray hist=readHistory(c,"data/eyupsultan-station-temperature-history.json");
   Double old=closest24(hist);
   if(old!=null) cmp="Son 24 saatten "+delta(current-old)+"° "+(current<old?"daha soğuk":current>old?"daha sıcak":"fark yok");
   if(Double.isFinite(balm)) cmp += " · Balmumcu'dan "+delta(current-balm)+"° "+(current<balm?"daha soğuk":current>balm?"daha sıcak":"aynı");
  }
  e.putString("dashboard_comparison",cmp);
  double measured=val(eyup,"precipitation_1h_mm");
  e.putString("dashboard_current_rain",Double.isFinite(measured)
   ?"MGM Eyüpsultan ölçümüne göre şu anda "+(measured>=0.1?"yağış var":"yağış yok")+" ("+fmt(measured)+" mm/son 1 saat)."
   :"MGM Eyüpsultan anlık yağış ölçümü alınamıyor.");
  e.putString("dashboard_dry_window",dryWindow(forecast));
  e.putString("dashboard_heavy_rain",heavy(forecast));
  e.putString("dashboard_source","İSTANBUL · CANLI GÖZLEM"+(stale?" · ESKİ VERİ":""));
  String observed=eyup==null?"":eyup.optString("observed_at_utc","");
  e.putString("dashboard_updated",observed.isEmpty()?"Ölçüm zamanı yok":"MGM ölçümü · "+local(parse(observed))+(stale?" · Eski ölçüm":""));
  e.apply();
 }
 private static JSONArray readHistory(Context c,String path){
  try {String raw=CacheFiles.read(c,path); if(raw==null)return null; JSONObject d=new JSONObject(raw);
   JSONArray a=d.optJSONArray("samples"); if(a==null)a=d.optJSONArray("history"); if(a==null)a=d.optJSONArray("observations"); return a;
  }catch(Exception x){return null;}
 }
 private static Double closest24(JSONArray a){
  if(a==null)return null; long target=System.currentTimeMillis()-86400000L,best=Long.MAX_VALUE; Double value=null;
  for(int i=0;i<a.length();i++){JSONObject o=a.optJSONObject(i);if(o==null)continue;
   long t=parse(o.optString("observed_at_utc",o.optString("logged_at_utc","")));double v=val(o,"temperature_2m_c");
   long diff=Math.abs(t-target);if(t>0&&diff<best&&diff<10800000L&&Double.isFinite(v)){best=diff;value=v;}
  }return value;
 }
 private static String dryWindow(JSONArray a){
  if(a==null||a.length()<2)return "MeteoPT GFS verisi yetersiz; kuru aralık hesaplanamıyor.";
  long now=System.currentTimeMillis(); double step=6;
  for(int i=1;i<a.length();i++){long x=parse(a.optJSONObject(i).optString("valid_time_utc",""))-parse(a.optJSONObject(i-1).optString("valid_time_utc",""));if(x>0){step=x/3600000.0;break;}}
  java.util.ArrayList<long[]> wet=new java.util.ArrayList<>();
  for(int i=0;i<a.length();i++){JSONObject o=a.optJSONObject(i);if(o==null)continue;long end=parse(o.optString("valid_time_utc",""));double mm=val(o,"precipitation_6h_mm");if(end>0&&mm>=0.2)wet.add(new long[]{(long)(end-step*3600000),end});}
  long dry=0;for(long[] x:wet)if(x[0]<=now&&x[1]>now)dry=Math.max(dry,x[1]);
  if(dry==0){for(long[] x:wet)if(x[0]>now){return "MeteoPT GFS tahminine göre yağış başlangıcı: "+local(x[0])+"."; }return "MeteoPT GFS tahmininde belirgin yağış sinyali yok.";}
  boolean changed=true;while(changed){changed=false;for(long[] x:wet)if(x[0]<=dry&&x[1]>dry){dry=x[1];changed=true;}}
  for(long[] x:wet)if(x[0]>dry)return "MeteoPT GFS tahminine göre kuru aralık: "+local(dry)+"–"+local(x[0])+". Yağışın "+local(x[0])+" itibarıyla yeniden başlaması bekleniyor.";
  return "MeteoPT GFS tahminine göre yağış "+local(dry)+" itibarıyla sona eriyor.";
 }
 private static String heavy(JSONArray a){
  if(a==null)return "Kuvvetli yağış tahmini için GFS verisi yok.";
  for(int i=1;i<a.length();i++){JSONObject o=a.optJSONObject(i);if(o==null)continue;long end=parse(o.optString("valid_time_utc",""));double mm=val(o,"precipitation_6h_mm");if(end>System.currentTimeMillis()&&mm>2.0)return "Kuvvetli yağış uyarısı: "+local(end-3*3600000L)+" itibarıyla "+fmt(mm)+" mm / 3 saat (2,00 mm üzeri) tahmin ediliyor.";}
  return "GFS tahmininde 2,00 mm / 3 saat üzeri kuvvetli yağış sinyali yok.";
 }
 private static double val(JSONObject o,String k){return o==null?Double.NaN:o.optDouble(k,Double.NaN);}
 private static String delta(double n){return String.format(Locale.forLanguageTag("tr-TR"),"%.1f",Math.abs(n));}
 private static String fmt(double n){return delta(n);}
 private static long parse(String s){try{return java.time.Instant.parse(s).toEpochMilli();}catch(Exception e){return 0;}}
 private static String local(long t){return t<=0?"—":new SimpleDateFormat("dd MMM HH:mm",Locale.forLanguageTag("tr-TR")).format(new Date(t));}
}