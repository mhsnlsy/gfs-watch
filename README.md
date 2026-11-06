# İstanbul'un Havası

**Resmî sürüm: 1.4.3**

İstanbul ve seçili yerleşimler için GFS/ECMWF tahminlerini, canlı meteoroloji istasyonlarını ve yağış radarı verilerini bir araya getiren meteoroloji panosu.

- **Canlı site:** https://mhsnlsy.github.io/gfs-watch/
- **GitHub deposu:** https://github.com/mhsnlsy/gfs-watch

## Veri kaynakları

- **İstanbul GFS:** MeteoPT GFS — 41.014°N / 28.950°E; tek canonical tahmin kaynağı.
- **ECMWF IFS:** GFS'den ayrı tutulan tahmin akışı.
- **ENKA Balmumcu:** ENKA currentvalues.html canlı istasyon verisi.
- **MGM Eyüpsultan:** MGM 18101 son durum ölçümleri.
- **MGM Şişli:** MGM 18401 son durum ölçümleri.
- **Yağış radarı:** RainViewer.

## Otomatik işleyiş

### İstanbul istasyonları — Cloudflare

İstanbul canlı istasyonlarının toplama ve arşiv servisi Cloudflare Worker + D1'dir.

- Worker: `gfs-watch-stations`
- Cron: `* * * * *` — dakikada bir.
- D1: `gfs-watch-stations` — güncel ölçüm ve kayan 72 saatlik geçmiş.
- Kaynaklar: ENKA Balmumcu, MGM Eyüpsultan (18101), MGM Şişli (18401).
- Her istasyon bağımsız sorgulanır; bir kaynaktaki hata diğerlerini durdurmaz.
- Pages, istasyon API'sini doğrudan okur. İstasyon verisi için GitHub Actions veya Pages build beklenmez.

API uç noktaları:

- `/api/health` — Cron, D1 ve istasyon yazım durumu.
- `/api/stations` — üç istasyonun son ölçümleri.
- `/api/stations/enka`, `/api/stations/eyupsultan`, `/api/stations/sisli` — tek istasyon.
- `/api/history/{station_key}?hours=72` — D1 geçmişi.

### İstanbul GFS — GitHub Actions

`.github/workflows/istanbul-gfs-github.yml` İstanbul GFS'nin tek canlı toplama ve yayın akışıdır.

Günlük dört kontrol/yayın penceresi (UTC cron):

| GFS döngüsü | İstanbul saati |
|---|---:|
| 00Z | 07:20 |
| 06Z | 13:20 |
| 12Z | 19:20 |
| 18Z | 01:20 (ertesi gün) |

Her çalıştırma:

1. MeteoPT'den 00Z, 06Z, 12Z ve 18Z döngülerini kontrol eder.
2. İstenen döngü saati ile API'nin döndürdüğü döngüyü doğrular.
3. **F180 yoksa yayın yapmaz.**
4. En yeni F180-hazır döngüyü bir kez canonical JSON olarak arşivler.
5. Aynı canonical veriden raporu, dört karşılaştırma PNG'sini ve Pages bildirim arşivini üretir.
6. Raporu ve aynı döngüye ait dört PNG'yi Telegram'a gönderir.
7. Run JSON'larını, PNG'leri, raporu ve Telegram gönderim işaretini `istanbul-gfs-data` dalına kaydeder.
8. GitHub Pages publisher'ını tetikler.

GFS yayınında Cloudflare kullanılmaz. GFS verisi, grafik üretimi, Telegram bildirimi ve Pages arşivinin sahibi GitHub Actions'tır. Aynı döngü için `gfs/notifications/telegram-sent/` altında işaret bulunduğunda tekrar bildirim gönderilmez. Manuel `workflow_dispatch` de aynı F180 ve tekrar-yayın kontrolünden geçer.

GFS kaynak kodu:

- `scripts/fetch_istanbul_gfs_meteopt.py` — MeteoPT sorgusu, cycle doğrulama ve F180 kapısı.
- `scripts/build_istanbul_gfs_publication.py` — canonical rapor, JSON ve dört PNG.
- `scripts/send_canonical_istanbul_gfs_telegram.py` — canonical rapor ve görsellerin Telegram gönderimi.

### GitHub Pages

`.github/workflows/publish-live-site.yml` tek Pages deployment noktasıdır.

Publisher:

- GFS verisini `istanbul-gfs-data` dalından,
- Köy GFS verisini `koy-gfs-data` dalından,
- Köy MGM verisini `koy-mgm-data` dalından,
- Site kaynak kodunu `main/site/` dizininden

alarak tek site paketi oluşturur ve GitHub Pages'e yayımlar.

GFS ana JSON'u `site/data/istanbul-gfs-latest.json`, rapor arşivi `site/data/notifications/latest.json` olarak sunulur. GFS sayfaları Cloudflare GFS API'sine değil, bu statik Pages dosyalarına bağlanır. Yeni GFS yayını tamamlandığında ortak Pages publisher doğrudan tetiklenir.

## Veri saklama

- `istanbul-gfs-data/gfs/runs/`: MeteoPT GFS döngü arşivi.
- `istanbul-gfs-data/gfs/latest.json`: son canonical GFS paketi.
- `istanbul-gfs-data/gfs/comparison.json`: son dört döngünün karşılaştırma verisi.
- `istanbul-gfs-data/gfs/notifications/`: son dört rapor ve PNG arşivi.
- `gfs-watch-stations` D1: istasyonların 72 saatlik geçmişi.
- `koy-gfs-data`: Çanakçı GFS verileri.
- `koy-mgm-data`: Çanakçı MGM gözlem ve arşiv verileri.

## Telegram bildirimleri

Her yeni F180-hazır GFS döngüsünde rapor ve dört karşılaştırma görseli Telegram'a gönderilir.

Gerekli GitHub Actions secrets:

- `TELEGRAM_TOKEN`
- `CHAT_ID`

## Cloudflare görev sınırı

Cloudflare yalnızca canlı istasyon toplama/arşivleme (`station-worker/`) ve gerektiğinde Web Push API (`push-worker/`) için kullanılır.

**İstanbul GFS için Cloudflare Worker, Cron, KV veya GFS API bağlantısı yoktur.** Eski `workers/istanbul-gfs/` runtime ve GFS Cloudflare deployment workflow'ları kaldırılmıştır.

## Mimari ilkesi

```
İstasyon kaynakları
       │
       ▼
Cloudflare Worker + D1
       │
       ▼
Pages istasyon kartları


MeteoPT GFS (00Z / 06Z / 12Z / 18Z)
       │
       ▼
GitHub Actions · F180 kapısı
       │
       ▼
Canonical GFS JSON + rapor + dört PNG
       │
       ├────────► Telegram
       │
       ▼
istanbul-gfs-data
       │
       ▼
Tek GitHub Pages Publisher
       │
       ▼
GitHub Pages
```

## Sürüm yönetimi

Resmî sürümün tek kaynağı `site/version.json` dosyasıdır.

- **PATCH:** hata düzeltmesi veya küçük iyileştirme.
- **MINOR:** geriye uyumlu yeni özellik.
- **MAJOR:** büyük mimari değişiklik veya uyumsuzluk.

Yalnızca dokümantasyon değişiklikleri uygulama sürümünü artırmaz.
