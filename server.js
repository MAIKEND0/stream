const express = require('express');
const NodeMediaServer = require('node-media-server');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Store aktywnych streamów
const activeStreams = new Map();

// Konfiguracja Node Media Server
const config = {
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },
  http: {
    port: 8000,
    allow_origin: '*',
    mediaroot: './media'
  },
  trans: {
    ffmpeg: '/usr/bin/ffmpeg',
    tasks: [
      {
        app: 'live',
        hls: true,
        hlsFlags: '[hls_time=2:hls_list_size=3:hls_flags=delete_segments]',
        hlsKeep: false,
        dash: true,
        dashFlags: '[f=dash:window_size=3:extra_window_size=5]',
        dashKeep: false
      }
    ]
  }
};

const nms = new NodeMediaServer(config);

// API Endpoints
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    server: 'eFootball Streaming Server',
    activeStreams: activeStreams.size,
    endpoints: {
      health: '/health',
      createStream: 'POST /api/stream/create',
      startStream: 'POST /api/stream/start',
      stopStream: 'POST /api/stream/stop'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    activeStreams: activeStreams.size
  });
});

// Endpoint do tworzenia streamu (wywoływany z frontendu)
app.post('/api/stream/create', (req, res) => {
  const { userId, youtubeKey, title } = req.body;
  
  // Generuj unikalny klucz streamu dla użytkownika
  const streamKey = `user_${userId}_${Date.now()}`;
  
  // Zapisz mapowanie
  activeStreams.set(streamKey, {
    userId,
    youtubeKey,
    title,
    startTime: new Date(),
    rtmpUrl: `rtmp://${process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost'}/live/${streamKey}`,
    youtubeUrl: `rtmp://a.rtmp.youtube.com/live2/${youtubeKey}`
  });
  
  console.log(`[Stream Created] ${streamKey} -> YouTube: ${youtubeKey}`);
  
  res.json({
    success: true,
    streamKey,
    rtmpUrl: `rtmp://${process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost'}/live/${streamKey}`,
    message: 'Stream utworzony. Użyj RTMP URL w OBS.'
  });
});

// Start retransmisji na YouTube
app.post('/api/stream/start', (req, res) => {
  const { streamKey } = req.body;
  const stream = activeStreams.get(streamKey);
  
  if (!stream) {
    return res.status(404).json({ error: 'Stream not found' });
  }
  
  // Tu możemy dodać logikę FFmpeg do retransmisji
  console.log(`[Stream Started] ${streamKey}`);
  stream.status = 'live';
  
  res.json({
    success: true,
    message: 'Stream started',
    youtubeUrl: `https://youtube.com/watch?v=${stream.youtubeKey}`
  });
});

// Stop streamu
app.post('/api/stream/stop', (req, res) => {
  const { streamKey } = req.body;
  
  if (activeStreams.has(streamKey)) {
    const stream = activeStreams.get(streamKey);
    console.log(`[Stream Stopped] ${streamKey} - Duration: ${Date.now() - stream.startTime}ms`);
    activeStreams.delete(streamKey);
  }
  
  res.json({
    success: true,
    message: 'Stream stopped'
  });
});

// Lista aktywnych streamów
app.get('/api/streams', (req, res) => {
  const streams = Array.from(activeStreams.entries()).map(([key, data]) => ({
    key,
    userId: data.userId,
    title: data.title,
    startTime: data.startTime,
    status: data.status || 'ready'
  }));
  
  res.json({ streams });
});

// Event handlers dla Media Server
nms.on('preConnect', (id, args) => {
  console.log('[NodeEvent preConnect]', `id=${id} args=${JSON.stringify(args)}`);
});

nms.on('postConnect', (id, args) => {
  console.log('[NodeEvent postConnect]', `id=${id} args=${JSON.stringify(args)}`);
});

nms.on('prePublish', (id, StreamPath, args) => {
  console.log('[NodeEvent prePublish]', `id=${id} StreamPath=${StreamPath}`);
  
  // Wyciągnij streamKey ze ścieżki
  const streamKey = StreamPath.split('/').pop();
  const stream = activeStreams.get(streamKey);
  
  if (stream) {
    console.log(`[Stream Active] Retransmitting to YouTube: ${stream.youtubeUrl}`);
    // Tu możemy dodać automatyczną retransmisję na YouTube
  }
});

nms.on('postPublish', (id, StreamPath, args) => {
  console.log('[NodeEvent postPublish]', `id=${id} StreamPath=${StreamPath}`);
});

nms.on('donePublish', (id, StreamPath, args) => {
  console.log('[NodeEvent donePublish]', `id=${id} StreamPath=${StreamPath}`);
  
  const streamKey = StreamPath.split('/').pop();
  if (activeStreams.has(streamKey)) {
    activeStreams.delete(streamKey);
  }
});

// Start serwerów
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 API Server running on port ${PORT}`);
  console.log(`📡 Public URL: ${process.env.RAILWAY_PUBLIC_DOMAIN || 'http://localhost:' + PORT}`);
});

nms.run();
console.log('📺 RTMP Server running on port 1935');
console.log('🌐 HTTP Streaming on port 8000');

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  nms.stop();
  process.exit(0);
});