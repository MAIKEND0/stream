const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// YouTube API setup
const youtube = google.youtube('v3');
const OAuth2 = google.auth.OAuth2;

const oauth2Client = new OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.YOUTUBE_REDIRECT_URI || 'https://stream-production-3d38.up.railway.app/auth/youtube/callback'
);

// Set credentials if available
if (process.env.YOUTUBE_ACCESS_TOKEN && process.env.YOUTUBE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    access_token: process.env.YOUTUBE_ACCESS_TOKEN,
    refresh_token: process.env.YOUTUBE_REFRESH_TOKEN
  });
  google.options({ auth: oauth2Client });
}

// Store active streams
const activeStreams = new Map();

// Health check
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

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    uptime: process.uptime(),
    activeStreams: activeStreams.size,
    youtubeAuth: !!(process.env.YOUTUBE_ACCESS_TOKEN)
  });
});

// YouTube OAuth
app.get('/auth/youtube', (req, res) => {
  try {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/youtube',
        'https://www.googleapis.com/auth/youtube.force-ssl',
        'https://www.googleapis.com/auth/youtube.readonly'
      ],
      prompt: 'consent'
    });
    console.log('[OAuth] Redirecting to:', authUrl);
    res.redirect(authUrl);
  } catch (error) {
    console.error('[OAuth] Error generating auth URL:', error);
    res.status(500).json({ 
      error: 'Failed to generate auth URL',
      details: error.message 
    });
  }
});

app.get('/auth/youtube/callback', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.status(400).json({ error: 'No authorization code provided' });
  }
  
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    // Store tokens (in production, save to database)
    console.log('YouTube tokens received:');
    console.log('ACCESS_TOKEN:', tokens.access_token);
    console.log('REFRESH_TOKEN:', tokens.refresh_token);
    
    res.send(`
      <html>
        <body style="background: #1a1a1a; color: white; font-family: Arial; padding: 20px;">
          <h1>✅ YouTube Authorization Success!</h1>
          <p>Add these to Railway environment variables:</p>
          <pre style="background: #333; padding: 15px; border-radius: 5px;">
YOUTUBE_ACCESS_TOKEN=${tokens.access_token}
YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}
          </pre>
          <p>Then restart the server.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('OAuth error:', error);
    res.status(500).json({ error: 'Failed to get tokens' });
  }
});

// Create YouTube stream
app.post('/api/stream/create', async (req, res) => {
  try {
    const { title, description, privacy } = req.body;
    
    if (!process.env.YOUTUBE_ACCESS_TOKEN) {
      return res.status(401).json({
        error: 'YouTube not authorized',
        authUrl: '/auth/youtube'
      });
    }
    
    // Create broadcast
    const broadcast = await youtube.liveBroadcasts.insert({
      part: ['snippet', 'status', 'contentDetails'],
      requestBody: {
        snippet: {
          title: title || '🔴 LIVE - eFootball Mobile Polska',
          description: description || 'Transmisja na żywo z gry eFootball Mobile',
          scheduledStartTime: new Date().toISOString(),
        },
        status: {
          privacyStatus: privacy || 'public',
          selfDeclaredMadeForKids: false,
        },
        contentDetails: {
          enableAutoStart: true,
          enableAutoStop: true,
          recordFromStart: true,
          monitorStream: {
            enableMonitorStream: true,
            broadcastStreamDelayMs: 0
          },
        }
      }
    });
    
    console.log('[YouTube] Broadcast created:', broadcast.data.id);
    
    // Create stream
    const stream = await youtube.liveStreams.insert({
      part: ['snippet', 'cdn', 'status'],
      requestBody: {
        snippet: {
          title: `Stream for ${title || 'eFootball Mobile'}`,
          description: 'Automatic stream created by eFootball Streamer'
        },
        cdn: {
          frameRate: '30fps',
          ingestionType: 'rtmp',
          resolution: '1080p'
        }
      }
    });
    
    console.log('[YouTube] Stream created:', stream.data.id);
    
    // Bind stream to broadcast
    await youtube.liveBroadcasts.bind({
      part: ['id', 'contentDetails'],
      id: broadcast.data.id,
      streamId: stream.data.id
    });
    
    console.log('[YouTube] Stream bound to broadcast');
    
    // Get stream details
    const streamKey = stream.data.cdn?.ingestionInfo?.streamName || '';
    const rtmpUrl = stream.data.cdn?.ingestionInfo?.ingestionAddress || 'rtmp://a.rtmp.youtube.com/live2';
    const watchUrl = `https://www.youtube.com/watch?v=${broadcast.data.id}`;
    
    // Store stream info
    const streamInfo = {
      broadcastId: broadcast.data.id,
      streamId: stream.data.id,
      streamKey: streamKey,
      rtmpUrl: rtmpUrl,
      watchUrl: watchUrl,
      title: title,
      createdAt: new Date().toISOString()
    };
    
    activeStreams.set(streamKey, streamInfo);
    
    res.json({
      success: true,
      ...streamInfo,
      message: 'Stream created successfully! Use the streamKey in your iOS app.'
    });
    
  } catch (error) {
    console.error('[YouTube] Error creating stream:', error);
    res.status(500).json({
      error: error.message || 'Failed to create stream',
      details: error.response?.data?.error
    });
  }
});

// Start stream (transition to live)
app.post('/api/stream/start', async (req, res) => {
  try {
    const { broadcastId } = req.body;
    
    if (!broadcastId) {
      return res.status(400).json({ error: 'broadcastId is required' });
    }
    
    const response = await youtube.liveBroadcasts.transition({
      id: broadcastId,
      broadcastStatus: 'live',
      part: ['id', 'status']
    });
    
    console.log('[YouTube] Broadcast transitioned to live');
    
    res.json({
      success: true,
      status: response.data.status?.lifeCycleStatus,
      message: 'Stream is now live!'
    });
    
  } catch (error) {
    console.error('[YouTube] Error starting stream:', error);
    res.status(500).json({
      error: error.message || 'Failed to start stream'
    });
  }
});

// Stop stream
app.post('/api/stream/stop', async (req, res) => {
  try {
    const { broadcastId } = req.body;
    
    if (!broadcastId) {
      return res.status(400).json({ error: 'broadcastId is required' });
    }
    
    const response = await youtube.liveBroadcasts.transition({
      id: broadcastId,
      broadcastStatus: 'complete',
      part: ['id', 'status']
    });
    
    console.log('[YouTube] Broadcast stopped');
    
    // Remove from active streams
    for (const [key, stream] of activeStreams.entries()) {
      if (stream.broadcastId === broadcastId) {
        activeStreams.delete(key);
        break;
      }
    }
    
    res.json({
      success: true,
      status: response.data.status?.lifeCycleStatus,
      message: 'Stream stopped'
    });
    
  } catch (error) {
    console.error('[YouTube] Error stopping stream:', error);
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

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 YouTube Streaming Server running on port ${PORT}`);
  console.log(`📡 Public URL: ${process.env.RAILWAY_PUBLIC_DOMAIN || 'http://localhost:' + PORT}`);
  console.log(`📺 YouTube auth: ${process.env.YOUTUBE_ACCESS_TOKEN ? '✅ Connected' : '❌ Not connected'}`);
  
  if (!process.env.YOUTUBE_ACCESS_TOKEN) {
    console.log('\n⚠️  YouTube not authorized!');
    console.log(`👉 Visit: ${process.env.RAILWAY_PUBLIC_DOMAIN || 'http://localhost:' + PORT}/auth/youtube`);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});