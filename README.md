# İstanbul'un Havası

**Resmî sürüm: 1.4.3**

İstanbul için GFS ve ECMWF tahminlerini, gerçek istasyon gözlemlerini ve yağış/radar bilgisini bir araya getiren otomatik meteoroloji panosu.

- **Canlı site:** https://mhsnlsy.github.io/gfs-watch/
- **Depo:** https://github.com/mhsnlsy/gfs-watch

## Veri kaynakları

- **GFS:** Kullanıcının belirlediği tek GFS kaynağı [MeteoPT GFS](https://www.meteopt.com/modelos/gfs?lat=41.014&lon=28.950&lang=en). İstanbul koordinatları 41.014°N, 28.950°E.
- **ECMWF IFS:** Ayrı tahmin akışı; GFS verisinin yerine geçmez.
- **ENKA Balmumcu:** Kamera görüntüsünden OCR ile alınan istasyon gözlemleri.
- **Eyüpsultan:** İstasyon gözlemleri ve geçmiş ölçüm arşivi.
- **Yağış radarı:** RainViewer verisi.

GFS ve ECMWF tahminleri ayrı tutulur; arayüzde model seçimiyle görüntülenir. GFS'nin ilk 72 saatlik tablo verisi MeteoPT çevrimi ilerledikçe hazırlanır.

## Otomatik işleyiş

- GitHub Actions, GFS çevrimlerini düzenli aralıklarla kontrol eder ve mevcut çevrimi işler.
- İstasyon yenileme ve radar kontrolü kendi otomatik iş akışlarında yürütülür.
- Yeni tahmin veya istasyon verisi yayıma hazır olduğunda GitHub Pages güncellenir.
- Tahmin ve istasyon geçmişi `gfs-watch-state` dalında saklanır; site bu daldan hazırlanan yayın verilerini kullanır.
- İş akışları gerektiğinde GitHub Actions üzerinden elle de çalıştırılabilir.

## Bildirimler

- Tamamlanan GFS çevrimleri için Telegram raporları ve karşılaştırma görselleri gönderilir.
- Bildirimlerde uygulama adı ve resmî sürüm numarası bulunur.
- Telegram için depo ayarlarında `TELEGRAM_TOKEN` ve `CHAT_ID` Actions secrets olarak tanımlanmalıdır.

## Yayın ve sürüm yönetimi

GitHub Pages, `main` dalındaki site dosyaları ile `gfs-watch-state` dalındaki güncel veri dosyaları birleştirilerek yayımlanır.

Resmî sürümün tek kaynağı `site/version.json` dosyasıdır. Web arayüzü ve Telegram raporları aynı dosyadan sürüm bilgisini alır.

Sürüm artışını değişikliğin kapsamına göre proje bakımını yapan kişi belirler:

- **PATCH**: hata düzeltmesi veya küçük iyileştirme (ör. 1.4.3 → 1.4.4)
- **MINOR**: geriye uyumlu yeni özellik (ör. 1.4.3 → 1.5.0)
- **MAJOR**: büyük mimari değişiklik veya uyumsuzluk (ör. 1.4.3 → 2.0.0)

Yalnızca dokümantasyon değişiklikleri uygulama sürümünü artırmaz.
