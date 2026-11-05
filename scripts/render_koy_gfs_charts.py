#!/usr/bin/env python3
import json, os
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
from matplotlib.lines import Line2D
from matplotlib import dates as mdates

TZ=ZoneInfo("Europe/Istanbul")
C=["#55D6D2","#7EB8FF","#FFC66D","#C3A5FF"]
BG="#071826"; AX="#102A3A"; TXT="#F2F7FA"; MUT="#9FB5C1"; GRID="#294253"; LEG="#16384A"; EDGE="#2B5369"

def dt(v): return datetime.fromisoformat(str(v).replace("Z","+00:00"))
def day(v): return dt(v).astimezone(TZ).date().isoformat()
def runlabel(v): 
    d=dt(v); return f"{d:%H}Z | {d.astimezone(TZ):%d.%m %H:%M} UTC"

def prep(runs):
    runs=sorted(runs,key=lambda r:dt(r["run_id_utc"]))
    common=None; series=[]
    for r in runs:
        pts=[p for p in r.get("forecast_6_hourly",[]) if float(p.get("forecast_hour",0) or 0)>0]
        daily={}
        for p in pts:
            d=day(p["valid_time_utc"]); x=daily.setdefault(d,{"t":[],"t850":[],"rain":[],"wind":[]})
            for src,key in [("temperature_2m_c","t"),("temperature_850hpa_c","t850"),("precipitation_6h_mm","rain"),("wind_speed_10m_kmh","wind")]:
                try:
                    if p.get(src) is not None:x[key].append(float(p[src]))
                except: pass
        common=set(daily) if common is None else common & set(daily)
        series.append({"run":r,"points":pts,"daily":daily})
    return series,sorted(common or [])

def base(title,ylabel,dates,precip=False):
    fig,ax=plt.subplots(figsize=(16,7)); fig.patch.set_facecolor(BG); ax.set_facecolor(AX)
    ax.set_ylabel(ylabel,fontsize=16,fontweight="bold",color=TXT,labelpad=8)
    ax.tick_params(axis="y",labelsize=14,labelcolor=MUT,colors=MUT)
    ax.tick_params(axis="x",labelsize=13,labelcolor=TXT,colors=TXT,pad=7)
    for t in ax.get_yticklabels():t.set_fontweight("bold")
    ax.grid(axis="y",color=GRID,alpha=.65); ax.set_axisbelow(True)
    fig.text(.085,.675,title,ha="left",va="bottom",fontsize=18,fontweight="bold",color=TXT)
    if not precip:
        wd=("Pzt","Sal","Çar","Per","Cum","Cmt","Paz")
        ax.set_xticks(range(len(dates))); ax.set_xticklabels([f"{datetime.fromisoformat(d):%d.%m} {wd[datetime.fromisoformat(d).weekday()]}" for d in dates],color=TXT)
        ax.set_xlim(-.5,max(.5,len(dates)-.5))
    return fig,ax

def save(path,title,ylabel,draw,series,dates,precip=False):
    fig,ax=base(title,ylabel,dates,precip); draw(ax)
    hs=[Line2D([0],[0],color=C[i],lw=3,label=("YENİ · " if i==len(series)-1 else "")+runlabel(s["run"]["run_id_utc"])) for i,s in enumerate(series)]
    fig.legend(handles=hs,loc="upper center",bbox_to_anchor=(.5,.925),ncol=2,fontsize=12,frameon=True,facecolor=LEG,edgecolor=EDGE,framealpha=.98,labelcolor=TXT,borderpad=.75,handlelength=2,columnspacing=3)
    fig.text(.01,.012,"Renkler her panelde aynı GFS döngüsünü gösterir | Kaynak: MeteoPT GFS",fontsize=10.5,color=MUT)
    fig.subplots_adjust(left=.085,right=.985,bottom=.19,top=.59)
    fig.savefig(path,dpi=150,facecolor=BG,edgecolor=BG);plt.close(fig)

def main():
    root=Path(os.environ.get("KOY_GFS_DIR","gfs")); data=json.loads((root/"comparison.json").read_text(encoding="utf-8"))
    runs=(data.get("runs") or [])[:4]
    if not runs: raise SystemExit("Köy GFS comparison boş.")
    series,dates=prep(runs)
    if not dates: raise SystemExit("Ortak tahmin günü yok.")
    media=root/"media";media.mkdir(parents=True,exist_ok=True);stamp=dt(runs[0]["run_id_utc"]).strftime("%Y%m%dT%HZ")
    off=lambda i:(i-(len(series)-1)/2)*min(.20,.80/len(series))
    def temp(ax):
        for si,s in enumerate(series):
            for di,d in enumerate(dates):
                v=s["daily"][d]["t"]
                if v:
                    x=di+off(si);a,b=v[0],v[-1];lo,hi=min(v),max(v);ax.vlines(x,lo,hi,color=C[si],lw=1.7);ax.add_patch(Rectangle((x-.07,min(a,b)),.14,max(abs(a-b),.12),facecolor=C[si],edgecolor=C[si],alpha=.86))
    def t850(ax):
        for si,s in enumerate(series):
            for di,d in enumerate(dates):
                v=s["daily"][d]["t850"]
                if v:
                    x=di+off(si);ax.vlines(x,min(v),max(v),color=C[si],lw=2.5);ax.scatter([x,x],[min(v),max(v)],color=C[si],s=25,zorder=3)
    def rain(ax):
        for si,s in enumerate(series):
            x=[];y=[]
            for p in s["points"]:
                if p.get("precipitation_6h_mm") is not None:x.append(dt(p["valid_time_utc"]).astimezone(TZ));y.append(max(0,float(p["precipitation_6h_mm"])))
            if x:ax.plot(x,y,color=C[si],lw=2.4,marker="o",markersize=3.4)
        ax.set_ylim(bottom=0);ax.xaxis.set_major_locator(mdates.HourLocator(interval=24,tz=TZ));ax.xaxis.set_major_formatter(mdates.DateFormatter("%d.%m\n%H:%M",tz=TZ));ax.tick_params(axis="x",labelsize=11);ax.grid(axis="x",color=GRID,alpha=.25)
    def wind(ax):
        for si,s in enumerate(series):
            for di,d in enumerate(dates):
                v=s["daily"][d]["wind"]
                if v:ax.bar(di+off(si),max(v),width=min(.16,.72/len(series)),color=C[si],alpha=.92)
        ax.set_ylim(bottom=0)
    specs=[("temperature","2 M SICAKLIK","2 m sıcaklık | Günlük mum: ilk–son, fitil: min–maks","°C",temp,False),("temperature_850","850 HPA SICAKLIK","850 hPa sıcaklığı | Günlük min–maks aralığı","°C",t850,False),("precipitation","YAĞIŞ","6 saatlik yağış · çizgi trend","mm / 6 saat",rain,True),("wind_10m","RÜZGÂR HIZ + YÖN","10 m rüzgâr | günlük maksimum hız","km/sa",wind,False)]
    for metric,label,title,ylabel,draw,precip in specs:
        save(media/f"koy-gfs-{stamp}-{metric}.png",f"ÇANAKÇI GFS | {label} · SON {len(series)} DÖNGÜ",ylabel,draw,series,dates,precip)
        (media/f"latest-{metric}.png").write_bytes((media/f"koy-gfs-{stamp}-{metric}.png").read_bytes())
    print(f"Köy GFS PNG hazır: {stamp}, {len(series)} döngü")

if __name__=="__main__":main()
