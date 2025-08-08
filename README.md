# 🎮 eFootball Streaming Server

RTMP Media Server dla streamingu meczów eFootball na YouTube.

## 🚀 Deploy na Railway

### 1. Przygotowanie
```bash
cd railway-streaming-server
git init
git add .
git commit -m "Initial streaming server"
```

### 2. Deploy
```bash
# Zainstaluj Railway CLI
npm install -g @railway/cli

# Zaloguj się
railway login

# Stwórz nowy projekt
railway new

# Deploy
railway up
```

### 3. Konfiguracja
W Railway Dashboard ustaw zmienne:
- Żadne nie są wymagane! Server automatycznie używa Railway domain

## 📡 Jak używać

### Dla Gracza:

1. **Idź na:** efootballmobilepolska.pl/stream
2. **Kliknij:** "Rozpocznij Stream"
3. **Dostaniesz:**
   ```
   RTMP URL: rtmp://your-app.up.railway.app/live/user_123_xxx
   ```
4. **W OBS:**
   - Settings → Stream
   - Service: Custom
   - Server: `rtmp://your-app.up.railway.app/live/`
   - Stream Key: `user_123_xxx`
5. **Start Streaming w OBS**

### API Endpoints:

- `GET /` - Info o serwerze
- `GET /health` - Status serwera
- `POST /api/stream/create` - Tworzy nowy stream
- `POST /api/stream/start` - Rozpoczyna retransmisję
- `POST /api/stream/stop` - Zatrzymuje stream
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