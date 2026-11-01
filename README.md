# GFS Watch

İstanbul için NOAA/NCEP GFS 0.25° tahminlerini doğrudan GRIB2 dosyalarından işleyen ve sonuçları Telegram üzerinden gönderen izleme sistemi.

## Nasıl çalışır?

- GFS GRIB2 dosyaları her tahmin saati için doğrudan NOAA NOMADS `gfs/prod/gfs.YYYYMMDD/HH/atmos/` dizininden alınır; NOMADS yanıt vermezse aynı dosyanın AWS S3 aynası denenir. İndirme kaynağı dosya bazında loglanır.
- Gerekli meteorolojik alanlar, Her dosyanın `.idx` envanterinden seçilir ve yalnızca raporun kullandığı sıcaklık, rüzgâr, yağış ve başlangıç basınç mesajlarının byte aralıkları indirilir. Yaklaşık 500 MB'lık küresel dosyanın tamamı indirilmez.
- Her yeni tahmin dosyası indirildiğinde ecCodes ile çözülür; İstanbul için sıcaklık, 10 m rüzgârı ve yağış değerleri önceden hazırlanıp önbelleğe yazılır.
- Ön veriler f000–f120 arasında saatlik, f123–f177 arasında üç saatlik adımlardan oluşur: toplam 140 lead. f180 son dosyadır. f180 yayımlandığında sistem önce 140 ön verinin hazır olduğunu doğrular, ardından f180'i alıp 141 zaman noktalı tahmini birleştirir.
- GFS döngüsü izlenirken NOAA S3 f180 envanteri ve ön GRIB2 alanları beş dakikalık sabit aralıklarla kontrol edilir. f000–f177 arasındaki 140 girdi her kontrol sırasında artımlı indirilip ecCodes ile çözülerek diskte saklanır; sonraki kontroller aynı önbellekten devam eder. f180 görünür olduğunda 140 girdinin tamamı doğrulanır, f180 birleştirilir ve rapor üretilir. Bir izleme oturumu 330 dakika sonunda tamamlanmazsa kısmi önbellek Actions Cache'e kaydedilir ve yeni oturum otomatik başlatılır.
- GRIB2 alanları yerel olarak ecCodes ile çözülür. Günlük sıcaklık, yağış ve rüzgâr özetleri modelin mevcut zaman adımlarından hesaplanır.
- Koordinat: **41.014°N, 28.950°E**. En yakın 0.25° GFS grid noktası **41.000°N, 29.000°E**; değerler tüm İstanbul için enterpolasyon değil, bu grid hücresi içindir.

## Otomatik çalışma

Aktif tek seferlik izleme hedefi **1 Kasım 2026 12Z** döngüsüdür. İlk başlatıcı workflow, **15:36:02 TSİ** saatine kadar bekler ve ardından izlemeyi başlatır. İzleme, yalnızca bu 12Z döngüsüne kilitlenmiştir; önceki bir döngünün f180 dosyası yanlışlıkla rapor tetiklemez.

İzleme oturumu NOAA'yı ve önbelleği her **300 saniyede (5 dakikada)** bir kontrol eder. Her runner en fazla 330 dakika izler; f180 henüz yayımlanmamışsa kısmi önbelleği saklayıp bir sonraki beş dakikalık sınırda yeni oturum açar. Hedef f180 işlenip rapor gönderildiğinde otomatik döngü durur.

Başka bir döngü için `.github/workflows/gfs-watch.yml` içindeki `GFS_PREFETCH_START_AT_UTC` ve `GFS_WATCH_TARGET_RUN_ID` değerleri birlikte güncellenmelidir.

## Kurulum

Repository → **Settings → Secrets and variables → Actions** bölümüne şu secrets değerlerini ekleyin:

- `TELEGRAM_TOKEN`: Telegram bot token'ı (zorunlu).
- `CHAT_ID`: Bildirim gönderilecek Telegram sohbeti (zorunlu).
- `GCP_SA_KEY`: Google Cloud servis hesabı JSON anahtarı (isteğe bağlı; yoksa metin bildirimi çalışır, ses üretimi atlanır).

GitHub Actions, ecCodes sistem kütüphanesini ve Python bağımlılıklarını çalışma sırasında kurar.

## Bildirimler ve grafik

- Her tamamlanan GFS döngüsü için bir Telegram metin raporu gönderilir.
- Ayrıca mevcut döngü ile önceki üç altı saatlik döngüyü karşılaştıran dört çevrimli grafik gönderilir.
- Sesli özet isteğe bağlıdır. TTS veya ses gönderimi başarısız olsa bile metin raporu gönderilmiş kalır.
- Karşılaştırma için geçmişte eksik olan bir tahmin NOAA'dan salt okunur alınabilir; bu işlem bildirim geçmişini veya kayıt veritabanını değiştirmez.

## Tahmin arşivi

Başarıyla işlenen tahminler `gfs-watch-state` dalında tutulur:

- [En son tahmin JSON](https://raw.githubusercontent.com/mhsnlsy/gfs-watch/gfs-watch-state/public/latest.json)
- Arşiv yolu: `public/runs/YYYYMMDDTHHZ.json`
- JSON, 141 yerel model zamanını, günlük özetleri, birimleri ve kaynak/koordinat bilgilerini içerir.
- SQLite geçmişi (`gfs_watch.db`) aynı dalda tutulur. Veritabanını elle silmeyin veya düzenlemeyin.
- Eski tahmin arşivleri 10 gün, tamamlanmamış GRIB2 önbellekleri 48 saat tutulur.

## Veri notları

f000 alanı canlı gözlem değildir; GFS modelinin başlangıç analizidir. Basınç analizi f000 deniz seviyesi basınç alanını kullanır ve İstanbul merkezli 2.500 km çaplı bölgeyi değerlendirir. Değerler °C, km/sa ve mm cinsine çevrilir.

## Web sitesi

İstanbul'un Havası, GitHub Pages üzerinde ücretsiz statik site olarak yayınlanır: https://mhsnlsy.github.io/gfs-watch/ . Site, GFS Watch'ın `gfs-watch-state` dalındaki `public/latest.json` tahmin çıktısını kullanır; başarılı GFS çalışmaları tamamlandığında web yayını otomatik yenilenir. İlk kurulumda **Settings → Pages → Build and deployment → Source** alanı **GitHub Actions** olarak seçilmeli ve `Deploy İstanbul'un Havası` workflow'u bir kez elle çalıştırılmalıdır.
