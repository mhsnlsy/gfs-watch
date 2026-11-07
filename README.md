# İstanbul'un Havası

**Resmî sürüm: 1.4.3**

İstanbul ve Çanakçı için GFS/ECMWF tahminleri, canlı meteoroloji istasyonları ve yağış radarını bir araya getiren meteoroloji panosu.

- **Canlı site (Cloudflare):** https://gfs-watch-web.muhsin-ulusoy.workers.dev/
- **GitHub Pages:** artık üretim/yedek yayın hedefi değildir; yalnızca tarihsel geri dönüş kaynağı olarak korunur.
- **GitHub deposu:** https://github.com/mhsnlsy/gfs-watch

## Üretim mimarisi

Canlı web arayüzü, API geçidi ve veri toplama servisleri Cloudflare üzerinde çalışır. GitHub, kaynak kodu ve sürüm geçmişi için kullanılır. GitHub Pages üretim ve yedek yayın hedefi değildir; yalnızca kaynak/depo geçmişinde korunur.

```text
                         Cloudflare CDN
                               │
                  gfs-watch-web · Static Assets
                               │
                same-origin API · Service Bindings
                 ┌─────────────┼──────────────┐
                 ▼             ▼              ▼
          İstanbul GFS       Köy GFS        Stations
          Worker + Cron      Worker + Cron  Worker + Cron
                 │             │              │
                 ▼             ▼              ▼
             D1 · Istanbul  D1 · Köy      D1 · Stations
                 └─────────────┼──────────────┘
                               ▼
                         Site / Browser
```

### Web katmanı

- Worker: `gfs-watch-web`
- Adres: `https://gfs-watch-web.muhsin-ulusoy.workers.dev`
- Sunum: Cloudflare Workers Static Assets (`web-worker/public`)
- Kaynak: `site/`; mevcut geçiş döneminde bildirim görselleri, ECMWF paketi ve Köy GFS karşılaştırma SVG'si deployment sırasında Static Assets'a eklenir.
- API yönlendirmesi: Cloudflare Service Bindings; tarayıcı istekleri aynı origin üzerinden yapılır.
- Sağlık kontrolü: `/__health`.
- Canlı GFS ve istasyon ölçümleri D1 API'lerinden gelir; bunlar için web deployment gerekmez.
- Arşiv sunumu R2-first olarak hazırlandı; `LIVE_ARCHIVE` binding'i yalnızca `CLOUDFLARE_R2_API_TOKEN` secret'ı tanımlandığında etkinleşir. Secret henüz tanımlı değilse canlı Worker mevcut D1/Static Assets fallback yolunda çalışır. R2 etkinleştiğinde ECMWF ve tarihsel bildirim arşivleri otomatik aktarılır.

### İstanbul GFS

- Worker: `gfs-watch-istanbul-gfs`
- Cron: `*/10 * * * *` (10 dakikada bir).
- D1: `gfs-watch-istanbul-gfs`.
- Kaynak: MeteoPT GFS, 41.014°N / 28.950°E.
- Worker 00Z, 06Z, 12Z ve 18Z seçicilerini kontrol eder; kullanılabilir döngüleri D1'e arşivler.
- F72 güncel paketi ve F180 tamamlanmış döngü arşivi D1'de tutulur.
- API: `/gfs/latest`, `/gfs/comparison`, `/api/health`.
- F180 tamamlandığında İstanbul GFS Worker, D1'deki son dört tam döngüyü aynı UTC geçerlilik saatlerine hizalar; rapor metnini ve etkileşimli dört panelli SVG'yi kendi içinde üretir, D1 yayın arşivine yazar ve Telegram'a metin + SVG dosyası gönderir. Teslimat adımları D1 outbox tablosunda tutulur; süreli atomik lease eşzamanlı Cron tekrarlarının aynı raporu göndermesini önler ve yarım kalan teslimatlar lease süresi dolduğunda kaldığı adımdan sürdürülür. Python/Matplotlib PNG hattı yalnızca manuel geri dönüş aracı olarak korunur.

### Köy GFS

- Worker: `gfs-watch-koy-gfs`
- Cron: `*/10 * * * *`.
- D1: `gfs-watch-koy-gfs`.
- Konum: Giresun / Çanakçı, 40.9557°N / 39.0065°E.
- API: `/api/koy-gfs/f72`, `/api/koy-gfs/comparison`, `/api/koy-gfs/latest`, `/api/koy-gfs/health`.
- Dört kullanılabilir döngü D1'e yazılır. Karşılaştırma API'si eksik arşivi ihtiyaç anında yeniden doldurmayı dener.
- Dört panelli etkileşimli Köy SVG'si aynı Worker içinde JavaScript ile üretilir ve `gfs_publication_assets` tablosuna kaydedilir; GitHub Actions/Matplotlib üretimi canlı akıştan çıkarılmıştır.
- SVG uçları: `/api/comparison.svg` (yeniden üretim/doğrulama) ve `/api/publication-asset/{key}` (D1'den yayın). Web Worker mevcut `/koy-data/gfs/media/...` adresini Service Binding üzerinden sunar.

### İstasyonlar

- Worker: `gfs-watch-stations`
- Cron: `*/2 * * * *` (2 dakikada bir).
- D1: `gfs-watch-stations`; kayan 72 saatlik ölçüm geçmişi.
- Kaynaklar: ENKA Balmumcu, MGM Eyüpsultan (18101), MGM Şişli (18401), MGM Çanakçı.
- Her istasyon bağımsız toplanır; bir kaynaktaki hata diğer istasyonları durdurmaz.
- API: `/api/stations`, `/api/stations/{station}`, `/api/history/{station}?hours=72`.
- Ana sayfa ve grafikler istasyon Worker'ına doğrudan gitmez; web Worker Service Binding üzerinden aynı origin'i kullanır.

### ECMWF ve diğer dış servisler

- ECMWF verisinin tek kaynağı MeteoPT ECMWF nokta serisidir: 41.0901°N / 28.9436°E. Veri GFS ile aynı mantıkta MeteoPT JSON endpoint'inden alınır; 2 m sıcaklık, 10 m rüzgâr, yağış, 850 hPa ve basınç aynı kaynaktan gelir. Doğrulanan JSON ve rapor görselleri D1'e yazılır; R2 etkinse aynı arşiv R2'ye de kopyalanır. ECMWF Open Data GRIB2/ecCodes/Container hattı üretimden çıkarılmıştır.
- Yağış radarı RainViewer'ın herkese açık harita API'sini kullanır.
- Web Push ayrı `gfs-watch-push` Worker'ı üzerinden yürür.

## GitHub Actions'ın kalan görevleri

GitHub Actions artık canlı İstanbul GFS veya istasyon verisini toplamaz.

| İş akışı | Görev |
|---|---|
| `deploy-cloudflare-platform.yml` | Yalnızca Cloudflare web Worker + Static Assets katmanını dağıtır; Service Binding ve API smoke testlerini yapar. GFS Worker'larını yeniden dağıtmaz. |
| `deploy-istanbul-gfs-worker.yml` | İstanbul GFS Worker + D1 migration ve Cron dağıtımını bağımsız yapar. |
| `deploy-koy-gfs-worker.yml` | Köy GFS Worker + D1 dağıtımını yapar; Worker-native SVG üretimini ve D1 yayınını doğrular. |
| `rebuild-koy-gfs-interactive-svg.yml` | Yalnızca manuel doğrulama; zamanlanmış SVG üretimi artık Cloudflare Worker içinde yapılır. |
| `deploy-stations-worker.yml` | İstasyon Worker + D1 dağıtımını yapar ve Cron/D1 geçmişini doğrular. |
| `deploy-gfs-guardian.yml` | 30 dakikalık düşük sıklıklı yedek watchdog; rapor akışı 8 saat sessiz kalırsa kurtarma tetiklemesi yapar. |
| `istanbul-gfs-10min.yml` | Yalnızca manuel acil durum/geri dönüş çalıştırması; normal F180 rapor üretimi ve Telegram teslimatı Cloudflare GFS Worker içinde yapılır. |
| `publish-live-site.yml` | GitHub Pages yedek kopyasını yalnızca manuel tetiklemeyle yayımlar. Üretim güncellemelerini bekletmez. |
| `ecmwf-eps.yml` | MeteoPT ECMWF nokta verisini alır, doğrular ve D1/R2 arşivine yayımlar. |

Kod değişikliklerinde Cloudflare deployment'ı GitHub üzerinden başlatılır; bu yalnızca dağıtım adımıdır. Web arayüzü değişikliği artık İstanbul GFS Worker + D1 deployment'ını tetiklemez. GitHub Pages üretim ortamında kullanılmaz; eski yayın workflow'u yalnızca elle çalıştırılabilir. İstanbul GFS F180 raporu, dört döngülü etkileşimli SVG ve Telegram teslimatı artık İstanbul GFS Worker'ın 10 dakikalık Cron'u içinde çalışır; GitHub Actions rapor üretiminde veya normal Telegram teslimatında runner açmaz. D1 outbox lease'leri yarım kalan ve çakışan teslimatları yönetir. GFS Guardian 30 dakikada bir çalışan yedek kontroldür; 8 saatlik sessizlikte devreye girer. Canlı GFS ve istasyon güncellemeleri web deployment'ına bağlı değildir. R2 token tanımlanana kadar arşiv okumaları D1/Static Assets fallback ile sürer. Köy SVG'si çalışma anında Köy Worker tarafından D1'e üretilir; yeni/eskimiş SVG için Service Binding fallback'i korunur.

## Veri saklama

- İstanbul GFS: `gfs-watch-istanbul-gfs` D1.
- Köy GFS: `gfs-watch-koy-gfs` D1.
- İstasyon geçmişi: `gfs-watch-stations` D1.
- İstanbul Telegram/SVG bildirim arşivi: canlı raporlar İstanbul GFS D1'de; geçmiş arşivlerin R2'ye toplu kopyası `CLOUDFLARE_R2_API_TOKEN` eklendiğinde etkinleşir.
- ECMWF: MeteoPT nokta serisinden doğrulanmış son veri ve rapor görselleri İstanbul D1'e yazılır; aynı dosyalar R2'ye yansıtılır.
- Köy GFS rapor SVG'leri: Köy Worker tarafından üretilir ve `gfs-watch-koy-gfs` D1 içinde saklanır.
- Köy MGM statik arşivi web paketinden çıkarıldı; güncel ölçümler Station Worker/D1 API'sinden alınır.
- GitHub dalları gerektiğinde geri yükleme ve arşiv kaynağı olarak korunur.

## Telegram

İstanbul GFS için yeni F180 raporunda Cloudflare Worker rapor metnini ve dört döngülü SVG karşılaştırmasını üretir; Telegram'a metin ve SVG dosyası gönderir. Teslimat kayıtları İstanbul GFS D1 içindeki `gfs_report_publications` outbox tablosunda tutulur; metin gönderilmiş ancak SVG gönderimi başarısız olmuşsa sonraki Cron yalnızca SVG adımını tekrarlar. Python/Matplotlib ile PNG gönderen GitHub workflow'u manuel geri dönüş seçeneği olarak kalır.

Gerekli GitHub Actions secrets:
- `TELEGRAM_TOKEN`
- `CHAT_ID`

## Mimari ilkesi

**Canlı çalışma:** Cloudflare Workers + Static Assets + D1 + Cron.

**Kaynak kodu ve sürüm kontrolü:** GitHub.

**Yayın:** Cloudflare Workers + Static Assets.

Canlı GFS/istasyon verisinin güncellenmesi için GitHub Pages build'i veya GitHub Actions deployment'ı beklenmez.
