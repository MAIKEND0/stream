const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Railway health check - musi być PIERWSZY
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Niektóre load balancery używają /healthz
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});
app.use(cors());
app.use(express.json());

// Store active streams
const activeStreams = new Map();

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    server: 'eFootball YouTube Streaming Server (Simple)',
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

// Druga wersja health dla debugowania
app.get('/health-detailed', (req, res) => {
  res.json({ 
    status: 'healthy',
    uptime: process.uptime(),
    activeStreams: activeStreams.size,
    youtubeAuth: !!(process.env.YOUTUBE_ACCESS_TOKEN)
  });
});

// Create mock stream (bez rzeczywistej integracji YouTube na razie)
app.post('/api/stream/create', async (req, res) => {
  try {
    const { title, description, privacy } = req.body;
    
    // Dla testów - generuj mock stream key
    const streamKey = `test-${Date.now()}-xxxx-xxxx`;
    const broadcastId = `broadcast-${Date.now()}`;
    const watchUrl = `https://youtube.com/watch?v=test${Date.now()}`;
    
    // Store stream info
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

// Start stream (mock)
app.post('/api/stream/start', async (req, res) => {
  try {
    const { broadcastId } = req.body;
    
    console.log('[Stream] Starting mock stream:', broadcastId);
    
    res.json({
      success: true,
      status: 'live',
      message: 'Mock stream started'
    });
    
  } catch (error) {
    console.error('[Stream] Error:', error);
    res.status(500).json({
      error: error.message || 'Failed to start stream'
    });
  }
});

// Stop stream (mock)
app.post('/api/stream/stop', async (req, res) => {
  try {
    const { broadcastId } = req.body;
    
    console.log('[Stream] Stopping mock stream:', broadcastId);
    
    // Remove from active streams
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
    
  } catch (error) {
    console.error('[Stream] Error:', error);
    res.status(500).json({
      error: error.message || 'Failed to stop stream'
    });
  }
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

// Start server - tak jak w ultra-simple który DZIAŁA!
const PORT = process.env.PORT || 3000;

console.log('Starting server...');
console.log('PORT from env:', process.env.PORT);
console.log('Using PORT:', PORT);

// Bez określania HOST - to działa w ultra-simple
const server = app.listen(PORT, () => {
  console.log(`🚀 YouTube Streaming Server listening on port ${PORT}`);
  console.log(`📡 Public URL: https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost:' + PORT}`);
  console.log(`📺 YouTube auth: ${process.env.YOUTUBE_ACCESS_TOKEN ? '✅ Connected' : '❌ Not connected'}`);
  console.log('Server address:', server.address());
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});