const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Store aktywnych streamów
const activeStreams = new Map();

// API Endpoints
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    server: 'eFootball Streaming Server',
    activeStreams: activeStreams.size,
    message: 'Use OBS to stream to YouTube directly',
    endpoints: {
      createStream: 'POST /api/stream/create',
      listStreams: 'GET /api/streams'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    uptime: process.uptime(),
    activeStreams: activeStreams.size
  });
});

// Endpoint do tworzenia streamu (wywoływany z frontendu)
// Ten endpoint tylko przechowuje informacje - OBS streamuje bezpośrednio na YouTube
app.post('/api/stream/create', (req, res) => {
  const { userId, title, description } = req.body;
  
  // Generuj unikalny identyfikator
  const streamId = `stream_${userId}_${Date.now()}`;
  
  // Zapisz informacje o streamie
  activeStreams.set(streamId, {
    userId,
    title,
    description,
    startTime: new Date(),
    status: 'created'
  });
  
  console.log(`[Stream Created] ${streamId} for user ${userId}`);
  
  // Zwróć informacje dla gracza
  // Gracz użyje tych danych w OBS
  res.json({
    success: true,
    streamId,
    instructions: {
      obs: {
        service: 'YouTube / YouTube Gaming',
        server: 'Primary YouTube ingest server',
        streamKey: 'Use your YouTube stream key from efootballmobilepolska.pl/stream'
      },
      message: 'Configure OBS with YouTube settings and start streaming'
    }
  });
});

// Lista aktywnych streamów
app.get('/api/streams', (req, res) => {
  const streams = Array.from(activeStreams.entries()).map(([key, data]) => ({
    id: key,
    userId: data.userId,
    title: data.title,
    startTime: data.startTime,
    status: data.status
  }));
  
  res.json({ 
    count: streams.length,
    streams 
  });
});

// Aktualizuj status streamu
app.post('/api/stream/status', (req, res) => {
  const { streamId, status } = req.body;
  
  if (activeStreams.has(streamId)) {
    const stream = activeStreams.get(streamId);
    stream.status = status;
    
    if (status === 'ended') {
      activeStreams.delete(streamId);
    }
    
    res.json({ success: true, status });
  } else {
    res.status(404).json({ error: 'Stream not found' });
  }
});

// CORS headers dla frontendu
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Start serwera
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 API Server running on port ${PORT}`);
  console.log(`📡 Public URL: ${process.env.RAILWAY_PUBLIC_DOMAIN || 'http://localhost:' + PORT}`);
  console.log('');
  console.log('📝 Instructions:');
  console.log('1. Frontend creates YouTube stream via API');
  console.log('2. User gets RTMP URL and Stream Key');
  console.log('3. User configures OBS with these credentials');
  console.log('4. User streams directly to YouTube via OBS');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});