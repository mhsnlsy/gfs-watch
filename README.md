# GFS Watch

İstanbul için NOAA/NCEP GFS 0.25° tahminlerini doğrudan GRIB2 dosyalarından işleyen ve sonuçları Telegram üzerinden gönderen izleme sistemi.

## Nasıl çalışır?

- Veri kaynağı NOAA'nın herkese açık S3 arşividir. Hava tahmini API'si veya NOMADS filtre servisi kullanılmaz.
- Gerekli meteorolojik alanlar, GRIB2 dosyalarının `.idx` envanterinden seçilir ve yalnızca ilgili byte aralıkları indirilir. Böylece yaklaşık 500 MB'lık küresel dosyanın tamamı indirilmez.
- Her yeni tahmin dosyası indirildiğinde ecCodes ile çözülür; İstanbul için sıcaklık, 10 m rüzgârı ve yağış değerleri önceden hazırlanıp önbelleğe yazılır.
- Ön veriler f000–f120 arasında saatlik, f123–f177 arasında üç saatlik adımlardan oluşur: toplam 140 lead. f180 son dosyadır. f180 yayımlandığında sistem önce 140 ön verinin hazır olduğunu doğrular, ardından f180'i alıp 141 zaman noktalı tahmini birleştirir.
- Her GFS döngüsü için GitHub Actions tek bir 90 dakikalık izleme başlatır. Bu süre boyunca NOAA S3'teki f180 dosyası 15 saniyede bir kontrol edilir; ön GRIB2 dosyaları eksikse 60 saniyede bir yeniden taranıp indirilir. Geçici 404, yayın gecikmesi veya ağ hatasında aynı izleme oturumu içinde tekrar denenir. İşlenmemiş döngü, izleme penceresi içinde tamamlandığında otomatik raporlanır.
- GRIB2 alanları yerel olarak ecCodes ile çözülür. Günlük sıcaklık, yağış ve rüzgâr özetleri modelin mevcut zaman adımlarından hesaplanır.
- Koordinat: **41.014°N, 28.950°E**. En yakın 0.25° GFS grid noktası **41.000°N, 29.000°E**; değerler tüm İstanbul için enterpolasyon değil, bu grid hücresi içindir.

## Otomatik çalışma

GitHub Actions zamanlaması İstanbul saatine (TSİ, UTC+3) göredir:

| Başlangıç (TSİ) | GFS döngüsü |
|---|---|
| 06:50 | 00Z |
| 12:50 | 06Z |
| 18:50 | 12Z |
| 00:50 | 18Z |

Her zamanlanmış çalışma ilgili döngüyü 90 dakika boyunca izler ve NOAA'yı 15 saniyede bir yeniden kontrol eder. GitHub zamanlanmış işleri birkaç dakika geciktirebilir. **Actions → GFS Watch → Run workflow** ile izleme elle de başlatılabilir.

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
