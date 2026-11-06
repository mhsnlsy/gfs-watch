# İstanbul'un Havası

**Resmî sürüm: 1.4.3**

İstanbul ve seçili yerleşimler için GFS/ECMWF tahminlerini, canlı meteoroloji istasyonlarını ve yağış radarı verilerini bir araya getiren meteoroloji panosu.

- **Canlı site:** https://mhsnlsy.github.io/gfs-watch/
- **GitHub deposu:** https://github.com/mhsnlsy/gfs-watch

## Veri kaynakları

- **GFS:** MeteoPT GFS — İstanbul, 41.014°N / 28.950°E (tek canonical kaynak).
- **ECMWF IFS:** GFS'den ayrı tutulan tahmin akışı.
- **ENKA Balmumcu:** ENKA currentvalues.html canlı istasyon verisi.
- **MGM Eyüpsultan:** MGM 18101 son durum ölçümleri.
- **MGM Şişli:** MGM 18401 son durum ölçümleri.
- **Yağış radarı:** RainViewer.

## Otomatik işleyiş

### İstanbul istasyonları

ENKA Balmumcu, MGM Eyüpsultan ve MGM Şişli **birbirinden bağımsız** GitHub Actions job'larıdır.

Her 5 dakikalık çevrimde her istasyon:

1. Kendi kaynağından güncel ölçümü alır.
2. Ölçümü doğrular; 20 dakikadan eski veriyi güncel kabul etmez.
3. Kendi 72 saatlik sıcaklık/yağış arşivini günceller.
4. Yalnızca kendi veri dalına yayın yapar.
5. Tamamlanan istasyon akışı ortak Pages publisher'ını tetikler.

İstasyon workflow'ları **uzun süre çalışan döngüler değildir**. Her workflow çalışması tek toplama/yayın çevrimidir. Böylece 5 dakikalık schedule yeni çalışmaları saatlerce kuyrukta bekletmez. GitHub'ın schedule tetiklemeleri yüksek yük altında gecikebilir; 5 dakika platformun desteklediği en kısa schedule aralığıdır.

Bir istasyonun başarısız olması diğer iki istasyonu durdurmaz.

| İstasyon | Workflow | Güncel veri | Arşiv |
|---|---|---|---|
| ENKA Balmumcu | `.github/workflows/istanbul-mgm-independent.yml` | ENKA currentvalues.html | 72 saat sıcaklık |
| MGM Eyüpsultan | `.github/workflows/istanbul-mgm-independent.yml` | MGM 18101 | 72 saat sıcaklık + yağış |
| MGM Şişli | `.github/workflows/istanbul-mgm-independent.yml` | MGM 18401 | 72 saat sıcaklık + yağış |

### GFS

`.github/workflows/istanbul-gfs-independent.yml` İstanbul GFS'nin **tek canlı toplama ve yayın hazırlama akışıdır**.

- 5 dakikada bir MeteoPT GFS'yi kontrol eder.
- Yeni döngüyü tek canonical paket olarak üretir.
- Aynı paketten raporu, dört Pages PNG'sini ve dört döngü karşılaştırmasını üretir.
- Canonical paket `istanbul-gfs-data` dalında saklanır.
- Telegram, aynı canonical rapor ve dört PNG'den oluşan tek medya albümünü gönderir.
- Aynı döngü için `telegram-sent` marker'ı tutulur; başarısız gönderim sonraki poll'da yeniden denenir.
- Pages deployment'ı ayrı ortak publisher tarafından yapılır; GFS workflow'u doğrudan Pages deploy etmez.

İstanbul GFS'nin veri kaynağı **yalnızca MeteoPT'dir**. Eski NOAA/Telegram polling yolu canlı akışın parçası değildir.

### GitHub Pages

`.github/workflows/publish-live-site.yml` **tek Pages deployment noktasıdır**.

Publisher:

- GFS verisini `gfs-watch-state` dalından,
- Köy GFS verisini `koy-gfs-data` dalından,
- Köy MGM verisini `koy-mgm-data` dalından,
- İstanbul istasyonlarını `main/site/data/` altından

alarak tek bir site paketi oluşturur ve GitHub Pages'e yayımlar.

İstasyon veya GFS toplayıcıları doğrudan Pages deploy etmez. Böylece aynı anda birden fazla workflow'un Pages deployment'ı üzerinde yarışması engellenir.

Publisher ayrıca 5 dakikalık zamanlanmış çalışmaya sahiptir; veri güncellendiğinde toplayıcı tarafından da doğrudan tetiklenir.

## Veri saklama

- `main/site/data/`: İstanbul istasyonlarının güncel gözlemleri ve arşivleri.
- `gfs-watch-state`: GFS veritabanı, run geçmişi ve yayıma hazırlanan GFS verileri.
- `koy-mgm-data`: Çanakçı MGM gözlem ve arşiv verileri.
- `koy-gfs-data`: Çanakçı GFS verileri.

## Telegram bildirimleri

Tamamlanan GFS çevrimleri için rapor ve karşılaştırma görselleri Telegram üzerinden gönderilir.

Gerekli GitHub Actions secrets:

- `TELEGRAM_TOKEN`
- `CHAT_ID`

## Mimari ilkesi

Bu projede canlı veri toplama ile Pages deployment'ı birbirinden ayrıdır:

```
ENKA ────────┐
Eyüpsultan ──┤
Şişli ───────┤
GFS ─────────┤
Köy GFS ─────┤
Köy MGM ─────┘
       │
       ▼
  Veri dalları
       │
       ▼
Tek Pages Publisher
       │
       ▼
GitHub Pages
```

Amaç basit: **veri toplayıcıları birbirini beklemez; yalnızca ortak yayın noktası Pages'tir.**

## Sürüm yönetimi

Resmî sürümün tek kaynağı `site/version.json` dosyasıdır.

- **PATCH:** hata düzeltmesi veya küçük iyileştirme.
- **MINOR:** geriye uyumlu yeni özellik.
- **MAJOR:** büyük mimari değişiklik veya uyumsuzluk.

Yalnızca dokümantasyon değişiklikleri uygulama sürümünü artırmaz.
