const http = require('http');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Store active streams
const activeStreams = new Map();

// Health endpoints MUST be first
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// Main endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    server: 'eFootball YouTube Streaming Server',
    activeStreams: activeStreams.size,
    youtubeAuth: !!(process.env.YOUTUBE_ACCESS_TOKEN),
    endpoints: {
      health: '/health',
      createStream: 'POST /api/stream/create',
      startStream: 'POST /api/stream/start',
      stopStream: 'POST /api/stream/stop'
    }
  });
});

// Create mock stream
app.post('/api/stream/create', async (req, res) => {
  try {
    const { title, description, privacy } = req.body;
    
    // Generate mock stream key
    const streamKey = `test-${Date.now()}-xxxx-xxxx`;
    const broadcastId = `broadcast-${Date.now()}`;
    const watchUrl = `https://youtube.com/watch?v=test${Date.now()}`;
    
    const streamInfo = {
      broadcastId,
      streamId: `stream-${Date.now()}`,
      streamKey,
      rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
      watchUrl,
      title: title || '🔴 LIVE - eFootball Mobile Polska',
      createdAt: new Date().toISOString(),
      status: 'created'
    };
    
    activeStreams.set(streamKey, streamInfo);
    
    console.log('[Stream] Created mock stream:', streamKey);
    
    res.json({
      success: true,
      ...streamInfo,
      message: 'Mock stream created for testing'
    });
    
  } catch (error) {
    console.error('[Stream] Error:', error);
    res.status(500).json({
      error: error.message || 'Failed to create stream'
    });
  }
});

// Start stream
app.post('/api/stream/start', async (req, res) => {
  const { broadcastId } = req.body;
  console.log('[Stream] Starting mock stream:', broadcastId);
  res.json({
    success: true,
    status: 'live',
    message: 'Mock stream started'
  });
});

// Stop stream
app.post('/api/stream/stop', async (req, res) => {
  const { broadcastId } = req.body;
  console.log('[Stream] Stopping mock stream:', broadcastId);
  
  for (const [key, stream] of activeStreams.entries()) {
    if (stream.broadcastId === broadcastId) {
      activeStreams.delete(key);
      break;
    }
  }
  
  res.json({
    success: true,
    status: 'complete',
    message: 'Mock stream stopped'
  });
});

// Get active streams
app.get('/api/streams', (req, res) => {
  const streams = Array.from(activeStreams.values());
  res.json({
    success: true,
    count: streams.length,
    streams
  });
});

// Create HTTP server from Express app - like ultra-simple that WORKS
const PORT = process.env.PORT || 3000;

// Create server using http.createServer like in ultra-simple
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`📡 Public URL: https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost:' + PORT}`);
  console.log(`📺 YouTube auth: ${process.env.YOUTUBE_ACCESS_TOKEN ? '✅ Connected' : '❌ Not connected'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});