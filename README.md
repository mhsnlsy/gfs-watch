# İstanbul'un Havası

**Resmî sürüm: 1.4.3**

İstanbul ve seçili yerleşimler için GFS/ECMWF tahminlerini, canlı meteoroloji istasyonlarını ve yağış radarı verilerini bir araya getiren meteoroloji panosu.

- **Canlı site:** https://mhsnlsy.github.io/gfs-watch/
- **GitHub deposu:** https://github.com/mhsnlsy/gfs-watch

## Veri kaynakları

- **GFS:** MeteoPT GFS — [İstanbul, 41.014°N / 28.950°E](https://www.meteopt.com/modelos/gfs?lat=41.014&lon=28.950&lang=en).
- **ECMWF IFS:** GFS'den ayrı tutulan tahmin akışı.
- **ENKA Balmumcu:** Canlı kamera görüntüsünden OCR ile okunan istasyon ölçümleri.
- **MGM Eyüpsultan:** MGM 18101 istasyonunun son durum ölçümleri.
- **MGM Şişli:** MGM 18401 istasyonunun son durum ölçümleri.
- **Yağış radarı:** RainViewer.

GFS ve ECMWF verileri birbirinden bağımsızdır; arayüzde model seçimiyle görüntülenir. MGM istasyonları her toplama turunda MGM'nin yayımladığı en son gözlemi alır. Kaynağın ölçüm zamanı değişmediyse yeni bir ölçüm zamanı üretilmez.

## Otomatik işleyiş

### İstanbul istasyonları

Üç istasyonun her biri kendi GitHub Actions iş akışında **5 dakikalık kendini yeniden kuyruğa alma döngüsü** kullanır. Her çalışmanın başında başlangıç zamanı kaydedilir; istasyon verisi toplanıp yayımlandıktan sonra aynı workflow, başlangıçtan itibaren 300 saniye dolunca kendi `workflow_dispatch` çağrısını gönderir. Toplama beş dakikadan uzun sürerse sonraki tur tamamlanınca hemen kuyruğa alınır.

Bu düzen ortak saat workflow'una, Cloudflare sırrına veya GitHub'ın zamanlanmış `schedule` olaylarına bağımlı değildir. Her istasyonun ayrı concurrency kilidi vardır. Bir toplayıcının hatası diğer iki istasyonun döngüsünü durdurmaz; iptal edilmemiş başarısız bir tur da kendi sonraki denemesini planlar.

Çanakçı MGM'deki gibi, `main` dalındaki normal bir kod/yapılandırma değişikliği de üç toplayıcıyı uyandırır. İstasyonların kendi çıktı dosyaları `paths-ignore` kapsamındadır; böylece bir istasyonun kendi commit'i tekrar tetiklenip döngü oluşturmaz. Her workflow'un `actions: write` izni yalnızca kendi bir sonraki çalışmasını `GITHUB_TOKEN` ile kuyruğa alması için kullanılır.

| İstasyon | İş akışı | Güncel veri | Arşiv |
|---|---|---|---|
| ENKA Balmumcu | `.github/workflows/main-station-refresh.yml` | Kamera OCR | 72 saatlik sıcaklık |
| MGM Eyüpsultan | `.github/workflows/eyupsultan-mgm-refresh.yml` | MGM 18101 | 72 saatlik sıcaklık ve yağış |
| MGM Şişli | `.github/workflows/sisli-mgm-refresh.yml` | MGM 18401 | 72 saatlik sıcaklık ve yağış |

Her toplayıcı yalnızca kendi istasyon dosyalarını günceller. Bir istasyondaki hata diğer istasyonların çalışmasını durdurmaz. İstasyon gözlemleri ve arşivleri `main/site/data/` altında saklanır.

### Tahminler, radar ve yayın

- **MeteoPT GFS:** `.github/workflows/meteopt-gfs-monitor.yml` ana izleyicisi 10 dakikada bir kontrol yapar.
- **GFS yedek kontrolü:** `.github/workflows/meteopt-gfs-monitor-backup.yml`, ana izleyicide beklenen zaman aralığında çalışma yoksa onu yeniden tetikler. Bu yedek kontrol yalnızca GFS içindir; İstanbul istasyonları bu mekanizmaya bağlı değildir.
- **ECMWF:** Kendi ayrı iş akışıyla alınır ve GFS geçmişinden ayrı saklanır.
- **Yağış radarı:** Kendi izleme iş akışını kullanır.
- **GitHub Pages:** `.github/workflows/pages-live.yml`, site dosyalarını ve ilgili veri dallarını birleştirerek yayına alır. Her istasyon toplayıcısı kendi dosyalarını `main/site/data/` altına yayımladıktan sonra bu yeniden kullanılabilir Pages iş akışını açıkça çağırır. Böylece Actions'ın `GITHUB_TOKEN` ile yapılan commit'lerinin başka bir `push` iş akışını otomatik başlatmaması sorun yaratmaz.

## Veri saklama

- `main/site/data/`: ENKA, Eyüpsultan ve Şişli'nin güncel gözlemleri ile istasyon arşivleri.
- `gfs-watch-state`: GFS işleme geçmişi, veritabanı ve yayıma hazırlanan GFS verileri.
- `koy-mgm-data`: Çanakçı MGM gözlem ve arşiv verileri.
- `koy-gfs-data`: Çanakçı GFS verileri.

## Telegram bildirimleri

Tamamlanan GFS çevrimleri için rapor ve karşılaştırma görselleri Telegram üzerinden gönderilir. Depo ayarlarında şu GitHub Actions secrets tanımlı olmalıdır:

- `TELEGRAM_TOKEN`
- `CHAT_ID`

## Sürüm yönetimi

Resmî sürümün tek kaynağı `site/version.json` dosyasıdır. Web arayüzü ve bildirimler sürüm bilgisini buradan alır.

- **PATCH:** Hata düzeltmesi veya küçük iyileştirme (ör. 1.4.3 → 1.4.4).
- **MINOR:** Geriye uyumlu yeni özellik (ör. 1.4.3 → 1.5.0).
- **MAJOR:** Büyük mimari değişiklik veya uyumsuzluk (ör. 1.4.3 → 2.0.0).

Yalnızca dokümantasyon değişiklikleri uygulama sürümünü artırmaz.
