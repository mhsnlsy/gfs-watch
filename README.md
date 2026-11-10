# İstanbul Havası

**Resmî sürüm: 1.5.0** (ana sayfa ve İstanbul GFS rapor SVG'si). Köy sayfasındaki sürüm etiketi `4.0-koy`.

İstanbul ve Çanakçı için GFS/ECMWF tahminleri, canlı meteoroloji istasyonları ve yağış radarını bir araya getiren meteoroloji panosu.

- **Canlı site:** https://istanbulunhavasi.com ve https://www.istanbulunhavasi.com (`gfs-watch-web`, Cloudflare Workers).
- **workers.dev:** https://gfs-watch-web.muhsin-ulusoy.workers.dev/
- **GitHub deposu:** https://github.com/mhsnlsy/gfs-watch

Üretim sitesi Cloudflare üzerindedir. `publish-live-site.yml` yalnızca elle çalıştırılan acil GitHub Pages yedeğidir; üretim adresi değildir.

## Üretim mimarisi

Canlı web arayüzü, API geçidi ve veri toplama Cloudflare üzerinde çalışır. GitHub kaynak kodu, doğrulama ve Worker dağıtımı içindir. GFS, ECMWF ve istasyon ölçümü Cloudflare Cron ile toplanır. Basınç merkezi JSON'u ayrı bir zamanlanmış GitHub işinde üretilir.

```text
                    istanbulunhavasi.com
                         Cloudflare CDN
                               │
                  gfs-watch-web · Static Assets
                               │
                same-origin API · Service Bindings
        ┌──────────────┬───────────────┬──────────────┐
        ▼              ▼               ▼              ▼
  İstanbul GFS      Köy GFS        Stations       (doğrudan
  Worker */10       Worker */10    Worker */2      bağ değil)
        │              │               │
        ▼              ▼               ▼
  D1 istanbul-gfs   D1 koy-gfs    D1 stations
        │
        ▼
  R2 gfs-watch-live-archive
        │
  Guardian */saat   Radar */6 + 19:45 TSİ   Push Worker
```

### Web katmanı

- Worker: `gfs-watch-web` (`web-worker/`)
- Özel alan adları: `istanbulunhavasi.com`, `www.istanbulunhavasi.com`
- Sunum: Cloudflare Workers Static Assets (`web-worker/public`). Kaynak arayüz `site/` altındadır; dağıtım bunu public pakete koyar.
- API yönlendirmesi: Service Binding. `ISTANBUL_GFS`, `KOY_GFS`, `STATIONS`. Tarayıcı aynı origin'i kullanır.
- Sağlık: `/__health`.
- Arşiv: R2 binding `LIVE_ARCHIVE`, bucket `gfs-watch-live-archive`. Bildirim ve ECMWF yolları önce R2, yoksa D1 veya Static Assets.
- Köy sayfası: `/koy.html`. Karşılaştırma grafiği `/api/publication-asset/notifications/koy-gfs-…svg` adresinden gelir; Köy Worker aynı damgayı `media/` anahtarıyla da tanır.

### İstanbul GFS

- Worker: `gfs-watch-istanbul-gfs` (`istanbul-gfs-worker/`)
- Cron: `*/10 * * * *`.
- D1 binding `GFS_DB`, veritabanı `gfs-watch-istanbul-gfs`.
- R2 binding `ECMWF_ARCHIVE`, bucket `gfs-watch-live-archive`.
- İstasyon binding'i: `STATIONS` → `gfs-watch-stations`.
- Kaynak: MeteoPT GFS, 41.014°N / 28.950°E.
- Worker 00Z, 06Z, 12Z ve 18Z seçicilerini kontrol eder; kullanılabilir döngüleri D1'e arşivler.
- F72 güncel paketi ve F180 tamamlanmış döngü arşivi D1'de tutulur.
- API: `/gfs/f72` en yeni kullanılabilir 72 saatlik döngü; `/gfs/latest` en yeni F180 döngüsü; `/gfs/comparison` dört F180 arşivi; `/api/health` sağlık.
- Ana sayfadaki 72 saat tablosu `/gfs/f72` kullanır. F180 raporu, dört panelli SVG ve Telegram, F180 tamamlanınca aynı Cron içinde üretilir.
- SVG D1 `gfs_publication_assets` içine yazılır. Aynı SVG Worker içinde PNG'ye çevrilir, R2'ye konur ve Telegram'a metin + fotoğraf (`sendPhoto`) olarak gider. Outbox `gfs_report_publications`; yarım kalan gönderi kaldığı adımdan sürer, en fazla 288 deneme.
- Grafik ekseni `shared/gfs-chart-axis.js` ile ortaktır. Sıcaklık ve 850 hPa adımı 5, rüzgâr 10, yağış 1'dir. Yağışın döngüler arasındaki en yüksek değeri 16'yı aşarsa o panelin adımı 2 olur. Son döngünün tepe değeri kalın çizgide tr-TR etiketidir; eksen çizgisi yapılmaz.
- `POST /internal/regenerate-latest-chart` son dört arşiv döngüsünden SVG'yi yeniden yazar. `Authorization: Bearer` ve Worker secret `GFS_DISPATCH_TOKEN` gerekir. İstanbul deploy işi bu ucu dağıtımdan sonra çağırır.
- `POST /internal/reconcile` aynı token ile toplama çalıştırır. Guardian bunu kullanır.

### Köy GFS

- Worker: `gfs-watch-koy-gfs` (`koy-gfs-worker/`)
- Cron: `*/10 * * * *`.
- D1 binding `GFS_DB`, veritabanı `gfs-watch-koy-gfs`.
- Konum: Giresun / Çanakçı, 40.9557°N / 39.0065°E. Kaynak MeteoPT GFS.
- Genel site yolları: `/api/koy-gfs/f72`, `/api/koy-gfs/comparison`, `/api/koy-gfs/latest`, `/api/koy-gfs/health`. Worker içindeki karşılıkları `/api/f72`, `/api/comparison`, `/api/latest`, `/api/health`.
- Dört döngü D1'e yazılır. Karşılaştırma eksikse Worker MeteoPT'ten doldurmayı dener.
- Dört panelli SVG Worker içinde üretilir ve `gfs_publication_assets` tablosuna `media/koy-gfs-…-comparison.svg` anahtarıyla yazılır. Eksen kuralı İstanbul ile aynı `shared/gfs-chart-axis.js` dosyasıdır.
- `GET /api/comparison.svg` grafiği yeniden üretir ve D1'e yazar. `GET /api/publication-asset/{key}` kayıtlı gövdeyi verir; renderer sürümü uyuşmuyorsa veya kayıt yoksa aynı damgayı yeniden üretir. `notifications/` ile `media/` aynı dosya adında birbirinin yerine geçer.
- Köy sayfası bu SVG'yi `/api/publication-asset/notifications/koy-gfs-…svg` ile ister.

### İstasyonlar

- Worker: `gfs-watch-stations` (`station-worker/`)
- Cron: `*/2 * * * *`.
- D1 binding `STATIONS_DB`, veritabanı `gfs-watch-stations`. Geçmiş ölçümler bu veritabanında tutulur.
- Kaynaklar, birbirinden bağımsız toplanır:
  - ENKA Balmumcu: WeatherLink current values HTML (`https://w.enka.com/weather/currentvalues.html`). Ana sayfadaki canlı kamera ayrı bir JPEG'dir (`https://w.enka.com/camhd/cam1/c.jpg`); ölçüm bu görüntüden okunmaz.
  - MGM Eyüpsultan, istasyon 18101.
  - MGM Şişli, istasyon 18401.
  - MGM Çanakçı.
- API: `/api/stations`, `/api/stations/{station}`, `/api/history/{station}?hours=72`.
- Ana sayfa ve Köy, istasyon Worker'ına doğrudan gitmez; web Worker Service Binding kullanır.

### ECMWF

- Tek üretim kaynağı MeteoPT ECMWF JSON'dur: `https://api.meteopt.com/ecmwf/json`, nokta 41.0901°N / 28.9436°E.
- Toplayan İstanbul GFS Worker'dır. Uçlar: `/ecmwf/latest` ve `/ecmwf/comparison` (site üzerinden `/api/ecmwf/latest` ve `/api/ecmwf/comparison`).
- Son paket D1'e yazılır ve `ECMWF_ARCHIVE` ile R2'ye `data/ecmwf/latest.json` olarak kopyalanır.
- ECMWF Open Data GRIB2/ecCodes hattı bu canlı akışta yoktur. Basınç merkezi işi ayrıdır ve aşağıdadır.

### Radar, Guardian ve Push

- Radar Worker: `gfs-watch-radar-monitor` (`radar-worker/`). Cron `*/6 * * * *` RainViewer karolarına bakar; İstanbul (41.015°N / 28.950°E) çevresinde 25 km. Güç eşiği 30 dBZ, Telegram uyarısı en az 45 dakika arayla. D1 binding `RADAR_DB`, veritabanı `gfs-watch-radar`.
- Aynı Worker `45 16 * * *` (19:45 TSİ) ile ertesi gün hava mesajını gönderir. İki gönderi arasında en az 1438 dakika vardır. `tomorrow-weather-telegram.yml` bunun elle çalışan yedeğidir.
- Guardian: `gfs-watch-gfs-guardian`. Cron `5,15,25,35,45,55 * * * *`. İstanbul GFS `/api/health` kaydına Service Binding ile bakar. Son başarılı toplama 25 dakikadan eskiyse ve yeni bir çalışma son 18 dakika içinde başlamamışsa `POST /internal/reconcile` çağırır. GitHub kullanmaz.
- Web Push: `gfs-watch-push` (`push-worker/`). D1 `gfs-watch-push`, binding `DB`. Dağıtım ancak repository variable `CLOUDFLARE_DEPLOY_ENABLED` değeri `true` ise çalışır. Ayrıntı `push-worker/SETUP.md` içindedir.

## GitHub Actions

Canlı GFS, ECMWF ve istasyon toplama Cloudflare Cron'dadır. Aşağıdaki işler kodu dağıtır, doğrular veya basınç merkezi JSON'unu günceller.

| İş akışı | Ne zaman | Görev |
|---|---|---|
| `validate.yml` | `main` push: `scripts/**`, `site/**`, `web-worker/**`, `istanbul-gfs-worker/**`, `koy-gfs-worker/**`, `station-worker/**`, `gfs-guardian/**`, ayrıca `validate.yml`, `publish-live-site.yml`, `deploy-cloudflare-platform.yml`, `deploy-istanbul-gfs-worker.yml`, `deploy-gfs-guardian.yml`. Elle de açılır. | Python sözdizimi ve çevrimdışı sözleşmeler; `node scripts/test_station_history_switch.mjs` ve `node scripts/test_istanbul_worker_publication.mjs`; Worker ve site JavaScript sözdizimi. |
| `deploy-cloudflare-platform.yml` | `site/**`, `web-worker/**`, `assets/brand/**`, `scripts/build_site_icons.py`, `gfs/**` ( `gfs/notifications/telegram-sent/**` hariç ), `mgm/**`, kendi workflow dosyası. | `gfs-watch-web` + Static Assets. GFS Worker'larını dağıtmaz. |
| `deploy-istanbul-gfs-worker.yml` | `istanbul-gfs-worker/**`, `shared/**`, kendi workflow dosyası. | İstanbul GFS Worker, D1 migration, Cron. Dağıtım `POST /internal/regenerate-latest-chart` çağırır. |
| `deploy-koy-gfs-worker.yml` | `koy-gfs-worker/**`, `shared/**`, kendi workflow dosyası. | Köy Worker, D1 migration. Dört arşiv döngüsü varsa `GET /api/comparison.svg` ile SVG'yi doğrular. |
| `deploy-stations-worker.yml` | `station-worker/**`, kendi workflow dosyası. | İstasyon Worker ve D1. |
| `deploy-radar-worker.yml` | `radar-worker/**`, kendi workflow dosyası. | Radar Worker ve D1. |
| `deploy-gfs-guardian.yml` | `gfs-guardian/**`, kendi workflow dosyası. | Guardian Worker. |
| `deploy-push-worker.yml` | `push-worker/**`, kendi workflow dosyası; `CLOUDFLARE_DEPLOY_ENABLED=true` şartı. | Push Worker. |
| `gfs-pressure-centers.yml` | `20 23,5,11,17 * * *` ve elle. | MSLP basınç merkezlerini üretir, `site/data/gfs-pressure-centers.json` dosyasını `main`'e yazar. Yarıçap 1250 km. |
| `live-site-visual-monitor.yml` | Platform veya İstanbul deploy'u bitince, `17 */6 * * *`, elle. | Canlı site görsel kontrolü. |
| `live-visual-check.yml` | Platform deploy'u başarılı bitince veya elle. | Masaüstü ve mobil tarayıcı kontrolü. |
| `rebuild-istanbul-gfs-images.yml` | Yalnızca elle. | Eski arşivden SVG/PNG yeniden kurup D1'e yükler. Günlük rapor üretimi Worker Cron'udur. |
| `rebuild-koy-gfs-interactive-svg.yml` | Yalnızca elle. | Canlı Köy SVG'sini doğrular; zamanlanmış üretimi Worker yapar. |
| `sync-cloudflare-live-archive.yml` | Yalnızca elle. | Veri dallarındaki arşivi R2'ye kopyalar. |
| `tomorrow-weather-telegram.yml` | Yalnızca elle. | 19:45 TSİ mesajının elle yedeği. Asıl gönderen radar Worker'dır. |
| `publish-live-site.yml` | Yalnızca elle. | Acil GitHub Pages yedeği. Üretim sitesini beklemez. |

`shared/**` değişince hem İstanbul hem Köy Worker dağıtılır. Web arayüzü değişikliği İstanbul veya Köy Worker'ını tek başına dağıtmaz.

## Veri saklama

- İstanbul GFS: D1 `gfs-watch-istanbul-gfs`.
- Köy GFS: D1 `gfs-watch-koy-gfs`. SVG gövdeleri `gfs_publication_assets`.
- İstasyonlar: D1 `gfs-watch-stations`.
- Radar: D1 `gfs-watch-radar`.
- Push: D1 `gfs-watch-push`.
- R2 bucket `gfs-watch-live-archive`: İstanbul Telegram PNG ve ECMWF JSON. Web Worker aynı bucket'ı `LIVE_ARCHIVE` ile okur.
- Basınç merkezleri: `site/data/gfs-pressure-centers.json`.
- Köy MGM statik arşivi web paketinde değildir; ölçüm istasyon API'sindendir.

Yerel `wrangler.jsonc` dosyalarında `database_id` yer tutucudur (`__D1_DATABASE_ID__`). Dağıtım işi veritabanını bulur veya oluşturur, kimliği yazar ve migration uygular.

## Telegram

İstanbul F180 raporu: Worker metin ve dört panelli SVG üretir, SVG'yi PNG yapar, ikisini gönderir. Kayıt D1 `gfs_report_publications` içindedir. PNG, `gfs-watch-live-archive` içindedir.

Radar yaklaşma uyarısı ve 19:45 TSİ ertesi gün mesajı `gfs-watch-radar-monitor` içinden gider.

## Kurulum ve dağıtım

### Önkoşullar

- Node.js 22 (Validate ve deploy işlerinin sürümü).
- İstanbul SVG testinden önce `istanbul-gfs-worker` içinde `npm install` (`@cf-wasm/resvg`).
- Cloudflare hesabı, Workers ve D1. Radar Cron'u ücretli Workers planındadır.
- Dağıtım GitHub Actions üzerinden yapılır. Yerel `wrangler deploy` zorunlu değildir. İşler Wrangler'ı kendileri kurar.

### GitHub secrets

Değer yazılmaz; yalnızca adlar.

- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`: Worker deploy işleri.
- `CLOUDFLARE_R2_API_TOKEN`: platform dağıtımındaki R2 adımı ve `sync-cloudflare-live-archive.yml`.
- `GFS_DISPATCH_TOKEN`: İstanbul Worker secret'ı, Guardian ve elle grafik yenileme. `POST /internal/regenerate-latest-chart` ile `POST /internal/reconcile` bu token'ı bekler.
- `TELEGRAM_TOKEN`, `CHAT_ID`: İstanbul rapor deploy'u, radar deploy'u ve elle ertesi gün mesajı. İstanbul işi `CHAT_ID` değerini Worker'a `TELEGRAM_CHAT_ID` olarak yazar.
- `PUSH_ADMIN_TOKEN`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`: Push Worker.

### GitHub variables

- `CLOUDFLARE_DEPLOY_ENABLED`: `true` değilse Push deploy çalışmaz.
- `PUSH_API_URL`: platform ve elle Pages işinin Push adresi.

### Yerel test

Validate'in Node adımları:

```bash
npm install --no-audit --no-fund --prefix istanbul-gfs-worker
node scripts/test_station_history_switch.mjs
node scripts/test_istanbul_worker_publication.mjs
node scripts/test_koy_worker_publication.mjs
```

`node scripts/test_*.mjs` bu üç dosyayı çalıştırır. Validate ayrıca `scripts/test_ecmwf_eps.py`, `test_ecmwf_ui.py`, `test_notification_pipeline.py`, `test_850hpa_history.py`, `test_gfs_wind_direction.py` ve `test_gfs_report_chart_theme.py` dosyalarını çalıştırır.

### Dağıtım

`main`'e push, yukarıdaki path listesine göre ilgili workflow'u başlatır. Deploy işleri `workflow_dispatch` ile de açılabilir. D1 kullanan Worker işleri veritabanı kimliğini çözer, `migrations` uygular, Worker'ı yayınlar ve canlı sağlık ucunu dener. Köy işi dört döngü varsa SVG'yi de yeniler. İstanbul işi son grafik varlığını `POST /internal/regenerate-latest-chart` ile yeniler.

## Mimari ilkesi

**Canlı çalışma:** Cloudflare Workers + Static Assets + D1 + R2 + Cron. Üretim adresi https://istanbulunhavasi.com.

**Kaynak kodu:** GitHub `main`.

**Grafik ekseni:** `shared/gfs-chart-axis.js`, İstanbul ve Köy için tek kural.

Canlı GFS ve istasyon verisi bir GitHub Pages build'i beklemez.
