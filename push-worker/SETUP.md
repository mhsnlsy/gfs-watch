# GFS Watch — iPhone Web Push kurulumu

Bu servis Cloudflare Workers Free + D1 Free ile çalışacak şekilde hazırlanmıştır. Apple Web Push için ücretli Apple Developer hesabı gerekmez.

## 1. VAPID anahtarlarını üret

Bilgisayarında Node.js kurulu olmalı. Terminal'de:

```bash
cd push-worker
npm install --no-package-lock
npm run generate-vapid
```

Çıktıdaki `publicKey` ve `privateKey` değerlerini ayır. `privateKey` değerini kimseyle paylaşma ve GitHub dosyasına yazma.

## 2. Cloudflare hesabı ve API token

1. Ücretsiz Cloudflare hesabı oluştur: https://dash.cloudflare.com/sign-up
2. Workers & Pages bölümünde `workers.dev` alt alan adını etkinleştir.
3. My Profile → API Tokens → Create Token bölümünden token oluştur.
4. Token'a yalnızca gerekli hesabında şu izinleri ver:
   - Workers Scripts: Edit/Write
   - D1: Edit/Write
   - Account Settings: Read
5. Hesap ana sayfasındaki Account ID değerini kopyala.

## 3. GitHub ayarları

Repository → Settings → Secrets and variables → Actions bölümüne aşağıdaki **Repository secrets** değerlerini ekle:

| Secret | Değer |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `PUSH_ADMIN_TOKEN` | `openssl rand -hex 32` komutuyla üreteceğin rastgele değer |
| `VAPID_PUBLIC_KEY` | 1. adımın publicKey değeri |
| `VAPID_PRIVATE_KEY` | 1. adımın privateKey değeri |

Aynı ekrandaki **Repository variables** bölümüne `CLOUDFLARE_DEPLOY_ENABLED` adında `true` değerli bir değişken ekle.

## 4. Worker'ı dağıt

GitHub → Actions → **Deploy GFS Watch Push API** → Run workflow.

Başarılı çalıştırmanın loglarında Worker URL'si görünür. Şu biçimdedir:

`https://gfs-watch-push.<workers-dev-alt-alan-adin>.workers.dev`

Bu URL'yi Repository variables bölümüne `PUSH_API_URL` adıyla ekle.

Ardından Actions → **Deploy İstanbul'un Havası** → Run workflow ile Pages'i yeniden dağıt. Böylece site, Push API adresini öğrenir.

## 5. iPhone

1. Safari'de https://mhsnlsy.github.io/gfs-watch/ adresini aç.
2. Paylaş → Ana Ekrana Ekle. “Web Uygulaması Olarak Aç” seçeneği görünüyorsa açık olsun.
3. Ana ekrandaki GFS Watch ikonunu aç.
4. “Arka plan bildirimlerini aç” düğmesine bas ve iOS bildirim iznini onayla.

Daha sonra GitHub Actions → **Send GFS Web Push** → Run workflow ile test edebilirsin. Test için `notification_id` alanına bildirim arşivindeki bir kayıt kimliğini yaz; boş bırakırsan en son kayıt gönderilir.

## Güvenlik notları

- VAPID private key ve PUSH_ADMIN_TOKEN yalnızca GitHub Secrets içinde tutulur.
- Push abonelikleri Cloudflare D1 içinde tutulur; GitHub deposuna yazılmaz.
- Cloudflare Worker dağıtımı için kullanılan API token yalnızca GitHub Secrets içindedir.
- Uygulama Telegram'a bildirim göndermeye devam eder; Web Push bağımsız bir yedek kanaldır.
