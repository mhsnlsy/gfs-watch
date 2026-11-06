# İstanbul GFS — Cloudflare publisher

Bu Worker artık İstanbul GFS'nin canlı collector/publisher katmanıdır.

## Mantık

Cloudflare Cron Trigger: **5 dakikada bir**.

Her poll:
1. MeteoPT'nin 00Z/06Z/12Z/18Z uçlarını kontrol eder.
2. En yeni run'ı seçer.
3. **F180 yoksa hiçbir yayın yapmaz.**
4. F180 geldiğinde run'ı KV'ye canonical olarak kaydeder.
5. Son 4 run'ı karşılaştırma paketi yapar.
6. 4 PNG üretir.
7. Telegram'a rapor + 4 görsel gönderir.
8. Pages'in tükettiği JSON/API uçlarını günceller.
9. Aynı run ikinci kez yayınlanmaz.

Cloudflare Cron Trigger'lar UTC çalışır; bu nedenle kullanıcıya görünen hedef saatler TSİ'dir. Cloudflare tarafındaki 5 dakikalık polling, F180'ün gerçek yayınlanma anını yakalar; sabit bir "13:20'de zorla çalış" yaklaşımına bağlı değildir.

## TSİ hedefleri

- 06Z → 13:20 TSİ
- 12Z → 19:20 TSİ
- 18Z → 01:20 TSİ
- 00Z → 07:20 TSİ

Worker 5 dakikada bir baktığı için gerçek F180 erişilebilir olduğu anda ilk uygun poll'da yayınlar.

## Cloudflare'da bir kez

1. KV namespace oluştur:
   `npx wrangler kv namespace create GFS_KV`
2. Çıkan ID'yi `wrangler.jsonc` içine yaz.
3. Secret ekle:
   `npx wrangler secret put TELEGRAM_TOKEN`
   `npx wrangler secret put TELEGRAM_CHAT_ID`
4. Deploy:
   `npx wrangler deploy`

## API

- `/health`
- `/gfs/latest`
- `/gfs/comparison`
- `/gfs/report`
- `/gfs/image-0` ... `/gfs/image-3`
- `/gfs/notification-latest`

Pages tarafındaki GFS ekranları bu API'yi okuyabilir; böylece GFS için GitHub Actions collector veya Pages publisher gerekmez.
