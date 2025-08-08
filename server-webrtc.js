const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const http = require('http');
const { spawn } = require('child_process');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store aktywnych streamów
const activeStreams = new Map();
const ffmpegProcesses = new Map();

// API Endpoints
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    server: 'eFootball Mobile Streaming Server',
    activeStreams: activeStreams.size,
    message: 'Stream directly from browser/phone!',
    endpoints: {
      websocket: 'wss://' + (process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost'),
      createStream: 'POST /api/stream/create'
    }
  });
});

// Tworzenie streamu i zwracanie danych do WebRTC
app.post('/api/stream/create', async (req, res) => {
  const { userId, title, description, youtubeKey, youtubeRtmpUrl } = req.body;
  
  try {
    const streamId = `stream_${Date.now()}`;
    
    // Użyj prawdziwych danych YouTube jeśli dostarczone, w przeciwnym razie mock
    const finalYoutubeKey = youtubeKey || `mock_${Math.random().toString(36).substr(2, 9)}`;
    const finalRtmpUrl = youtubeRtmpUrl || `rtmp://a.rtmp.youtube.com/live2/${finalYoutubeKey}`;
    
    activeStreams.set(streamId, {
      userId,
      title,
      description,
      youtubeKey: finalYoutubeKey,
      youtubeUrl: finalRtmpUrl,
      startTime: new Date(),
      status: 'ready'
    });
    
    console.log(`[Stream Created] ${streamId} for user ${userId}`);
    console.log(`[Stream] YouTube Key: ${finalYoutubeKey.substring(0, 10)}...`);
    console.log(`[Stream] RTMP URL: ${finalRtmpUrl}`);
    
    res.json({
      success: true,
      streamId,
      socketUrl: `wss://${process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost'}`,
      instructions: 'Connect via WebSocket to start streaming'
    });
    
  } catch (error) {
    console.error('[Create Stream Error]', error);
    res.status(500).json({ error: error.message });
  }
});

// WebSocket dla streamingu z przeglądarki
io.on('connection', (socket) => {
  console.log('[WebSocket] New connection:', socket.id);
  
  let currentStreamId = null;
  let ffmpeg = null;
  
  socket.on('start-stream', (data) => {
    const { streamId, youtubeRtmpUrl, youtubeKey } = data;
    console.log(`[WebSocket] Starting stream ${streamId}`);
    
    currentStreamId = streamId;
    const stream = activeStreams.get(streamId);
    
    if (!stream) {
      socket.emit('error', 'Stream not found');
      return;
    }
    
    // Użyj URL z danych streamu lub przekazanych parametrów
    const rtmpUrl = stream.youtubeUrl || youtubeRtmpUrl || `rtmp://a.rtmp.youtube.com/live2/${youtubeKey}`;
    console.log(`[WebSocket] Using RTMP URL: ${rtmpUrl}`);
    
    ffmpeg = spawn('ffmpeg', [
      // Input z stdin (dane z WebRTC)
      '-f', 'webm',
      '-i', 'pipe:0',
      
      // Kodowanie wideo
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-r', '30',
      '-g', '60',
      '-b:v', '2500k',
      '-maxrate', '2500k',
      '-bufsize', '5000k',
      
      // Kodowanie audio
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      
      // Output na YouTube
      '-f', 'flv',
      rtmpUrl
    ]);
    
    ffmpeg.stderr.on('data', (data) => {
      console.log('[FFmpeg]', data.toString());
    });
    
    ffmpeg.on('close', (code) => {
      console.log(`[FFmpeg] Process exited with code ${code}`);
      socket.emit('stream-ended');
    });
    
    ffmpegProcesses.set(streamId, ffmpeg);
    stream.status = 'live';
    socket.emit('stream-started', { streamId });
  });
  
  // Odbieranie danych wideo z przeglądarki
  socket.on('video-data', (data) => {
    if (currentStreamId && ffmpegProcesses.has(currentStreamId)) {
      const ffmpeg = ffmpegProcesses.get(currentStreamId);
      if (ffmpeg && ffmpeg.stdin && ffmpeg.stdin.writable) {
        try {
          // Konwertuj base64 na buffer jeśli potrzeba
          const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
          ffmpeg.stdin.write(buffer);
        } catch (error) {
          console.error('[Video Data Error]', error);
        }
      }
    }
  });
  
  socket.on('stop-stream', () => {
    console.log(`[WebSocket] Stopping stream ${currentStreamId}`);
    
    if (currentStreamId && ffmpegProcesses.has(currentStreamId)) {
      const ffmpeg = ffmpegProcesses.get(currentStreamId);
      if (ffmpeg) {
        ffmpeg.stdin.end();
        ffmpeg.kill('SIGTERM');
        ffmpegProcesses.delete(currentStreamId);
      }
      
      if (activeStreams.has(currentStreamId)) {
        activeStreams.delete(currentStreamId);
      }
    }
    
    socket.emit('stream-stopped');
  });
  
  socket.on('disconnect', () => {
    console.log('[WebSocket] Disconnected:', socket.id);
    
    // Cleanup jeśli stream był aktywny
    if (currentStreamId && ffmpegProcesses.has(currentStreamId)) {
      const ffmpeg = ffmpegProcesses.get(currentStreamId);
      if (ffmpeg) {
        ffmpeg.kill('SIGTERM');
        ffmpegProcesses.delete(currentStreamId);
      }
      activeStreams.delete(currentStreamId);
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    activeStreams: activeStreams.size,
    ffmpegProcesses: ffmpegProcesses.size
  });
});

// Lista streamów
app.get('/api/streams', (req, res) => {
  const streams = Array.from(activeStreams.entries()).map(([id, data]) => ({
    id,
    title: data.title,
    status: data.status,
    startTime: data.startTime
  }));
  
  res.json({ streams });
});

// Start serwera
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 WebRTC Streaming Server running on port ${PORT}`);
  console.log(`📱 Mobile/Browser streaming enabled!`);
  console.log(`🔗 WebSocket: wss://${process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost:' + PORT}`);
});