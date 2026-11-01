# GFS Watch

İstanbul için NOAA/NCEP GFS 0.25° tahminlerini doğrudan GRIB2 dosyalarından işleyen ve sonuçları Telegram üzerinden gönderen izleme sistemi.

## Nasıl çalışır?

- GFS GRIB2 dosyaları her tahmin saati için doğrudan NOAA NOMADS `gfs/prod/gfs.YYYYMMDD/HH/atmos/` dizininden alınır; NOMADS yanıt vermezse aynı dosyanın AWS S3 aynası denenir. İndirme kaynağı dosya bazında loglanır.
- Gerekli meteorolojik alanlar, Her dosyanın `.idx` envanterinden seçilir ve yalnızca raporun kullandığı sıcaklık, rüzgâr, yağış ve başlangıç basınç mesajlarının byte aralıkları indirilir. Yaklaşık 500 MB'lık küresel dosyanın tamamı indirilmez.
- Her yeni tahmin dosyası indirildiğinde ecCodes ile çözülür; İstanbul için sıcaklık, 10 m rüzgârı ve yağış değerleri önceden hazırlanıp önbelleğe yazılır.
- Ön veriler f000–f120 arasında saatlik, f123–f177 arasında üç saatlik adımlardan oluşur: toplam 140 lead. f180 son dosyadır. f180 yayımlandığında sistem önce 140 ön verinin hazır olduğunu doğrular, ardından f180'i alıp 141 zaman noktalı tahmini birleştirir.
- NOAA'daki 00Z, 06Z, 12Z ve 18Z döngülerinin f180 dosyaları her beş dakikada bir taranır. Her yeni döngü için f000–f177 arasındaki 140 girdi kendi tarih/saat dizininden artımlı indirilir, ecCodes ile çözülür ve döngüye özel önbellekte saklanır. f180 görünür olduğunda 140 girdinin tamamı doğrulanır, f180 de aynı kaynak sırasıyla alınır ve 141 zaman noktalı rapor oluşturulur. Birden fazla yeni döngü hazırsa kronolojik sırayla art arda işlenir. İzleme oturumu 330 dakika sonunda kısmi önbelleği Actions Cache'e kaydeder ve yeni oturumu otomatik başlatır.
- GRIB2 alanları yerel olarak ecCodes ile çözülür. Günlük sıcaklık, yağış ve rüzgâr özetleri modelin mevcut zaman adımlarından hesaplanır.
- Koordinat: **41.014°N, 28.950°E**. En yakın 0.25° GFS grid noktası **41.000°N, 29.000°E**; değerler tüm İstanbul için enterpolasyon değil, bu grid hücresi içindir.

## Otomatik çalışma

GitHub Actions sabit bir döngü saatine kilitlenmez. NOAA'nın son altı GFS çevrimi NOMADS üzerinden, gerekli dosya yoksa AWS S3 aynasından kontrol edilir. f180 dosyası hazır olan ve henüz raporlanmamış her çevrim kronolojik sırayla işlenir. Böylece 06Z gibi ara çevrimler de atlanmaz; önceki üç çevrimin verisi gerekirse kendi tarih/saat dizinlerinden salt okunur olarak tamamlanır.

İzleme ve ön indirme her **300 saniyede (5 dakikada)** bir çalışır. Her runner en fazla 330 dakika izler; tamamlanmamış GRIB2 önbelleği Actions Cache'e kaydedilir ve yeni izleme oturumu otomatik başlatılır. Yeni bir çevrim için elle UTC hedef saati güncellemek gerekmez.

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
