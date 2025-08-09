# 📺 eFootball YouTube Streaming Server

Serwer do obsługi streamingu z aplikacji mobilnej na YouTube Live przez API.

## 🚀 Deploy na Railway

### 1. Google Cloud Console Setup

1. Wejdź na [Google Cloud Console](https://console.cloud.google.com)
2. Włącz YouTube Data API v3
3. Utwórz OAuth 2.0 Client ID
4. **WAŻNE:** Dodaj Authorized redirect URIs:
   - `https://stream-production-3d38.up.railway.app/auth/youtube/callback`
   - `http://localhost:3000/auth/youtube/callback`

### 2. Railway Environment Variables

```env
YOUTUBE_CLIENT_ID=your_client_id_from_google
YOUTUBE_CLIENT_SECRET=your_client_secret_from_google
YOUTUBE_REDIRECT_URI=https://stream-production-3d38.up.railway.app/auth/youtube/callback
YOUTUBE_ACCESS_TOKEN=(będzie po autoryzacji)
YOUTUBE_REFRESH_TOKEN=(będzie po autoryzacji)
```

### 3. Pierwsza autoryzacja

1. Deploy na Railway
2. Wejdź na: `https://stream-production-3d38.up.railway.app/auth/youtube`
3. Zaloguj się na konto YouTube gdzie chcesz streamować
4. Skopiuj tokeny z ekranu
5. Dodaj tokeny do Railway environment variables
6. Zrestartuj serwer

## 📡 Jak używać

### Z aplikacji iOS:

1. **Aplikacja wysyła** request do `/api/stream/create`
2. **Serwer tworzy** stream na YouTube i zwraca:
   ```json
   {
     "streamKey": "xxxx-xxxx-xxxx-xxxx",
     "broadcastId": "abc123",
     "watchUrl": "https://youtube.com/watch?v=abc123"
   }
   ```
3. **iOS streamuje** przez RTMP na:
   ```
   rtmp://a.rtmp.youtube.com/live2/{streamKey}
   ```
4. **Stream pojawia się** automatycznie na YouTube!

### API Endpoints:

#### Health Check
- `GET /` - Info o serwerze z statusem YouTube auth
- `GET /health` - Status serwera

#### YouTube OAuth
- `GET /auth/youtube` - Rozpocznij autoryzację OAuth
- `GET /auth/youtube/callback` - Callback z tokenami

#### Streaming
- `POST /api/stream/create` - Tworzy stream na YouTube
  ```json
  Body: {
    "title": "🔴 LIVE - eFootball Mobile",
    "description": "Opis transmisji",
    "privacy": "public"
  }
  ```
- `POST /api/stream/start` - Przełącza stream w tryb live
- `POST /api/stream/stop` - Kończy transmisję
- `GET /api/streams` - Lista aktywnych streamów

## 🔧 Lokalne testowanie

```bash
npm install
npm start

# Test z OBS:
# Server: rtmp://localhost/live/
# Key: test123
```

## 📊 Monitoring

Railway Dashboard pokazuje:
- Zużycie CPU/RAM
- Logi w czasie rzeczywistym
- Aktywne połączenia

## 💰 Koszty

- **FREE:** $5 kredytu miesięcznie
- **Zużycie:** ~$0.01 per godzinę streamingu
- **Wystarczy na:** ~500 godzin/miesiąc

## 🎯 Integracja z frontendem

W `discord-fb-bridge/app/stream/page.tsx`:

```javascript
const response = await fetch('https://your-app.up.railway.app/api/stream/create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: session.user.id,
    youtubeKey: streamKey,
    title: streamTitle
  })
});
```

---

💡 **Support:** Discord @efootballpolska