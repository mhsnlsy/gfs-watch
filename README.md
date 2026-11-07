# İstanbul'un Havası

**Resmî sürüm: 1.4.3**

İstanbul ve Çanakçı için GFS/ECMWF tahminleri, canlı meteoroloji istasyonları ve yağış radarını bir araya getiren meteoroloji panosu.

- **Canlı site (Cloudflare):** https://gfs-watch-web.muhsin-ulusoy.workers.dev/
- **GitHub Pages:** artık üretim/yedek yayın hedefi değildir; yalnızca tarihsel geri dönüş kaynağı olarak korunur.
- **GitHub deposu:** https://github.com/mhsnlsy/gfs-watch

## Üretim mimarisi

Canlı web arayüzü, API geçidi ve veri toplama servisleri Cloudflare üzerinde çalışır. GitHub, kaynak kodu ve sürüm geçmişi için kullanılır. GitHub Pages yalnızca yedek yayın hedefidir.

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
- Arşiv dosyaları henüz R2'ye alınmadı. Worker'da R2-first/Static Assets fallback kodu hazır; R2 binding, yetkili token sağlandıktan sonra açılacak.

### İstanbul GFS

- Worker: `gfs-watch-istanbul-gfs`
- Cron: `*/10 * * * *` (10 dakikada bir).
- D1: `gfs-watch-istanbul-gfs`.
- Kaynak: MeteoPT GFS, 41.014°N / 28.950°E.
- Worker 00Z, 06Z, 12Z ve 18Z seçicilerini kontrol eder; kullanılabilir döngüleri D1'e arşivler.
- F72 güncel paketi ve F180 tamamlanmış döngü arşivi D1'de tutulur.
- API: `/gfs/latest`, `/gfs/comparison`, `/api/health`.
- GitHub Actions artık MeteoPT'yi tekrar sorgulamaz. Rapor üretim iş akışı Cloudflare API'sinden D1'deki son dört tam döngüyü alır; mevcut SVG/PNG raporunu ve Telegram mesajını üretir. Raporun SVG/PNG çıktılarının R2'ye taşınması sonraki aşamadır.

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

- ECMWF EPS tahmin dosyası şu an `.github/workflows/ecmwf-eps.yml` ile alınır ve Cloudflare Static Assets dağıtımına eklenir.
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
| `istanbul-gfs-10min.yml` | Cloudflare Worker yeni F180 döngüsünü D1'e yazınca olay tabanlı tetiklenir; rapor/PNG ve Telegram teslimatını yürütür. 10 dakikalık boş polling yoktur. |
| `publish-live-site.yml` | GitHub Pages yedek kopyasını yalnızca manuel tetiklemeyle yayımlar. Üretim güncellemelerini bekletmez. |
| `ecmwf-eps.yml` | ECMWF EPS veri hazırlığını yürütür; henüz Cloudflare Cron'a taşınmamıştır. |

Kod değişikliklerinde Cloudflare deployment'ı GitHub üzerinden başlatılır; bu yalnızca dağıtım adımıdır. Web arayüzü değişikliği artık İstanbul GFS Worker + D1 deployment'ını tetiklemez. GitHub Pages otomatik yayın akışından çıkarılmıştır; yalnızca manuel geri dönüş seçeneğidir. İstanbul GFS rapor/Telegram pipeline'ı 10 dakikada bir boş yere runner açmaz; yeni F180 geldiğinde Worker doğrudan workflow dispatch yapar. D1 outbox kuyruğu başarısız dispatch denemelerini sonraki Cron'a bırakır. GFS Guardian 30 dakikada bir çalışan yedek kontroldür; 8 saatlik sessizlikte devreye girer. Canlı GFS ve istasyon güncellemeleri web deployment'ına bağlı değildir. Arşivler R2'ye aktarılana kadar İstanbul bildirim/ECMWF varlıklarının Static Assets yedekleri korunur. Köy SVG'si artık çalışma anında Köy Worker tarafından D1'e üretilir; canlı sayfanın SVG sunumu için Köy veri branch'ine veya Static Assets derlemesine ihtiyaç duyulmaz.

## Veri saklama

- İstanbul GFS: `gfs-watch-istanbul-gfs` D1.
- Köy GFS: `gfs-watch-koy-gfs` D1.
- İstasyon geçmişi: `gfs-watch-stations` D1.
- İstanbul Telegram/SVG/PNG bildirim arşivi: geçiş sürecinde `istanbul-gfs-data` dalı ve Cloudflare Static Assets; R2 aktarımı bekliyor.
- ECMWF EPS: `gfs-watch-state/public/ecmwf`; R2 aktarımı bekliyor.
- Köy GFS rapor SVG'leri: Köy Worker tarafından üretilir ve `gfs-watch-koy-gfs` D1 içinde saklanır.
- Köy MGM statik arşivi web paketinden çıkarıldı; güncel ölçümler Station Worker/D1 API'sinden alınır.
- GitHub dalları gerektiğinde geri yükleme ve arşiv kaynağı olarak korunur.

## Telegram

İstanbul GFS için yeni F180 raporunda mevcut rapor metni ve karşılaştırma görseli Telegram'a gönderilir. Teslimat işaretleri `telegram-sent` altında tutulur; başarısız kısmi teslimatlar yeniden denenebilir.

Gerekli GitHub Actions secrets:
- `TELEGRAM_TOKEN`
- `CHAT_ID`

## Mimari ilkesi

**Canlı çalışma:** Cloudflare Workers + Static Assets + D1 + Cron.

**Kaynak kodu ve sürüm kontrolü:** GitHub.

**Yedek yayın:** GitHub Pages.

Canlı GFS/istasyon verisinin güncellenmesi için GitHub Pages build'i veya GitHub Actions deployment'ı beklenmez.
