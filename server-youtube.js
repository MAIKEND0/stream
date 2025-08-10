const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();

// Health check endpoints MUST be first (before any middleware)
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

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

app.get('/health-detailed', (req, res) => {
  res.json({ 
    status: 'healthy',
    uptime: process.uptime(),
    activeStreams: activeStreams.size,
    youtubeAuth: !!(process.env.YOUTUBE_ACCESS_TOKEN)
  });
});

// Ready check for YouTube auth
app.get('/ready', (req, res) => {
  const ready = !!(process.env.YOUTUBE_ACCESS_TOKEN && process.env.YOUTUBE_REFRESH_TOKEN);
  return ready ? res.status(200).send('READY') : res.status(503).send('NOT_READY');
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
          scheduledStartTime: new Date(Date.now() + 2 * 60 * 1000).toISOString(), // 2 minutes from now
        },
        status: {
          privacyStatus: privacy || 'public',
          selfDeclaredMadeForKids: false,
        },
        contentDetails: {
          enableAutoStart: false, // IMPORTANT: Don't auto-start, we control transitions manually
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
  const { broadcastId } = req.body;
  
  try {
    console.log('[YouTube] Start stream request:', { broadcastId });
    
    if (!broadcastId) {
      return res.status(400).json({ error: 'broadcastId is required' });
    }
    
    // First check the current status
    const statusCheck = await youtube.liveBroadcasts.list({
      id: [broadcastId],
      part: ['id', 'status', 'contentDetails']
    });
    
    if (!statusCheck.data.items || statusCheck.data.items.length === 0) {
      return res.status(404).json({ error: 'Broadcast not found' });
    }
    
    const broadcast = statusCheck.data.items[0];
    const currentStatus = broadcast.status?.lifeCycleStatus;
    const streamId = broadcast.contentDetails?.boundStreamId;
    
    console.log('[YouTube] Current broadcast status:', currentStatus);
    console.log('[YouTube] Bound stream ID:', streamId);
    
    // Don't check stream status here - we'll do it in the retry loop below
    
    // Handle different states
    if (currentStatus === 'ready') {
      if (!streamId) {
        return res.status(400).json({
          error: 'No stream bound',
          details: 'No stream is bound to this broadcast. Please create a new broadcast.'
        });
      }
      
      // Wait for stream to become active before transitioning
      console.log('[YouTube] Waiting for stream to become active...');
      console.log('[YouTube] Will check stream status every second for up to 30 seconds');
      
      let retries = 0;
      const maxRetries = 30; // 30 seconds total
      let streamActive = false;
      
      while (retries < maxRetries && !streamActive) {
        // Check stream status
        if (streamId) {
          const streamCheck = await youtube.liveStreams.list({
            id: [streamId],
            part: ['id', 'status']
          });
          
          if (streamCheck.data.items && streamCheck.data.items.length > 0) {
            const streamStatus = streamCheck.data.items[0].status;
            console.log(`[YouTube] Retry ${retries + 1}/${maxRetries} - Stream status:`, {
              streamStatus: streamStatus?.streamStatus,
              healthStatus: streamStatus?.healthStatus?.status
            });
            
            if (streamStatus?.streamStatus === 'active') {
              streamActive = true;
              console.log('[YouTube] ✅ Stream is now active and receiving data!');
              break;
            }
          }
        }
        
        retries++;
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
      }
      
      if (!streamActive) {
        return res.status(400).json({
          error: 'Stream not active',
          details: 'The stream did not become active within 30 seconds. Please ensure:\n1. You are streaming to the correct RTMP URL\n2. Your streaming key is correct\n3. Your streaming software is actively sending data',
          troubleshooting: {
            rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
            streamKey: 'Check your stream key in YouTube Studio',
            obs: 'In OBS, click "Start Streaming" and wait a few seconds'
          }
        });
      }
      
      // First transition to testing to verify stream
      console.log('[YouTube] Transitioning to testing state first...');
      
      try {
        await youtube.liveBroadcasts.transition({
          id: broadcastId,
          broadcastStatus: 'testing',
          part: ['id', 'status']
        });
        
        console.log('[YouTube] Successfully transitioned to testing');
        
        // Wait a moment for the transition to complete
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Now transition to live
        const liveResponse = await youtube.liveBroadcasts.transition({
          id: broadcastId,
          broadcastStatus: 'live',
          part: ['id', 'status']
        });
        
        console.log('[YouTube] Broadcast transitioned to live:', liveResponse.data);
        
        res.json({
          success: true,
          status: liveResponse.data.status?.lifeCycleStatus,
          message: 'Stream is now live!'
        });
      } catch (transitionError) {
        // If transition fails, provide helpful error message
        if (transitionError.response?.status === 403) {
          return res.status(400).json({
            error: 'Cannot start stream',
            details: 'Failed to transition to live. The stream may need more time to stabilize.',
            troubleshooting: {
              retry: 'Wait a few seconds and try again',
              verify: 'Check YouTube Studio to see if the stream is already live'
            }
          });
        }
        throw transitionError;
      }
    } else if (currentStatus === 'testing') {
      // Already in testing, go directly to live
      const response = await youtube.liveBroadcasts.transition({
        id: broadcastId,
        broadcastStatus: 'live',
        part: ['id', 'status']
      });
      
      console.log('[YouTube] Broadcast transitioned to live:', response.data);
      
      res.json({
        success: true,
        status: response.data.status?.lifeCycleStatus,
        message: 'Stream is now live!'
      });
    } else if (currentStatus === 'live') {
      // Already live
      res.json({
        success: true,
        status: currentStatus,
        message: 'Stream is already live!'
      });
    } else {
      // Cannot transition from current state
      console.log('[YouTube] Cannot transition to live from current state:', currentStatus);
      res.status(400).json({
        error: 'Cannot start stream',
        details: `Broadcast is in ${currentStatus} state. It must be in ready or testing state to go live.`,
        currentStatus
      });
    }
    
  } catch (error) {
    console.error('[YouTube] Error starting stream:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
      broadcastId
    });
    
    // Don't convert YouTube 4xx errors to 500
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message || 'Failed to start stream';
    
    if (status === 403 || status === 400 || status === 404) {
      return res.status(status).json({
        error: message,
        details: error.response?.data?.error,
        broadcastId
      });
    }
    
    res.status(500).json({
      error: message,
      details: error.response?.data?.error
    });
  }
});

// Get stream status
app.get('/api/stream/status/:broadcastId', async (req, res) => {
  try {
    const { broadcastId } = req.params;
    
    console.log('[YouTube] Get stream status:', { broadcastId });
    
    if (!broadcastId) {
      return res.status(400).json({ error: 'broadcastId is required' });
    }
    
    // Get broadcast details
    const broadcastCheck = await youtube.liveBroadcasts.list({
      id: [broadcastId],
      part: ['id', 'status', 'contentDetails', 'snippet']
    });
    
    if (!broadcastCheck.data.items || broadcastCheck.data.items.length === 0) {
      return res.status(404).json({ error: 'Broadcast not found' });
    }
    
    const broadcast = broadcastCheck.data.items[0];
    const streamId = broadcast.contentDetails?.boundStreamId;
    
    let streamHealth = null;
    
    // Get stream health if available
    if (streamId) {
      const streamCheck = await youtube.liveStreams.list({
        id: [streamId],
        part: ['id', 'status', 'cdn']
      });
      
      if (streamCheck.data.items && streamCheck.data.items.length > 0) {
        const stream = streamCheck.data.items[0];
        streamHealth = {
          streamStatus: stream.status?.streamStatus,
          healthStatus: stream.status?.healthStatus,
          ingestionInfo: {
            streamName: stream.cdn?.ingestionInfo?.streamName,
            ingestionAddress: stream.cdn?.ingestionInfo?.ingestionAddress
          }
        };
      }
    }
    
    res.json({
      broadcastId: broadcast.id,
      status: broadcast.status?.lifeCycleStatus,
      title: broadcast.snippet?.title,
      description: broadcast.snippet?.description,
      scheduledStartTime: broadcast.snippet?.scheduledStartTime,
      actualStartTime: broadcast.snippet?.actualStartTime,
      streamId: streamId,
      streamHealth: streamHealth,
      watchUrl: `https://youtube.com/watch?v=${broadcastId}`,
      canGoLive: streamHealth?.streamStatus === 'active' && 
                 (broadcast.status?.lifeCycleStatus === 'ready' || 
                  broadcast.status?.lifeCycleStatus === 'testing')
    });
    
  } catch (error) {
    console.error('[YouTube] Error getting stream status:', {
      message: error.message,
      response: error.response?.data
    });
    res.status(500).json({
      error: error.message || 'Failed to get stream status',
      details: error.response?.data?.error
    });
  }
});

// Stop stream
app.post('/api/stream/stop', async (req, res) => {
  try {
    const { broadcastId } = req.body;
    
    console.log('[YouTube] Stop stream request:', { broadcastId });
    
    if (!broadcastId) {
      return res.status(400).json({ error: 'broadcastId is required' });
    }
    
    // First check the current status
    const statusCheck = await youtube.liveBroadcasts.list({
      id: [broadcastId],
      part: ['id', 'status']
    });
    
    if (!statusCheck.data.items || statusCheck.data.items.length === 0) {
      return res.status(404).json({ error: 'Broadcast not found' });
    }
    
    const currentStatus = statusCheck.data.items[0].status?.lifeCycleStatus;
    console.log('[YouTube] Current broadcast status:', currentStatus);
    
    // Only transition to complete if the broadcast is currently live
    if (currentStatus === 'live') {
      const response = await youtube.liveBroadcasts.transition({
        id: broadcastId,
        broadcastStatus: 'complete',
        part: ['id', 'status']
      });
      
      console.log('[YouTube] Broadcast stopped:', response.data);
    } else {
      console.log('[YouTube] Broadcast not in live state, skipping transition. Current status:', currentStatus);
    }
    
    // Remove from active streams regardless
    for (const [key, stream] of activeStreams.entries()) {
      if (stream.broadcastId === broadcastId) {
        activeStreams.delete(key);
        break;
      }
    }
    
    res.json({
      success: true,
      status: currentStatus,
      message: 'Stream stop request processed'
    });
    
  } catch (error) {
    console.error('[YouTube] Error stopping stream:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
      broadcastId
    });
    res.status(500).json({
      error: error.message || 'Failed to stop stream',
      details: error.response?.data?.error
    });
  }
});

// Get broadcast status (simplified, without stream health)
app.get('/api/broadcast/status/:broadcastId', async (req, res) => {
  try {
    const { broadcastId } = req.params;
    
    const statusCheck = await youtube.liveBroadcasts.list({
      id: [broadcastId],
      part: ['id', 'status', 'snippet']
    });
    
    if (!statusCheck.data.items || statusCheck.data.items.length === 0) {
      return res.status(404).json({ error: 'Broadcast not found' });
    }
    
    const broadcast = statusCheck.data.items[0];
    res.json({
      success: true,
      broadcastId: broadcast.id,
      status: broadcast.status?.lifeCycleStatus,
      recordingStatus: broadcast.status?.recordingStatus,
      title: broadcast.snippet?.title,
      scheduledStartTime: broadcast.snippet?.scheduledStartTime,
      actualStartTime: broadcast.snippet?.actualStartTime,
      actualEndTime: broadcast.snippet?.actualEndTime
    });
    
  } catch (error) {
    console.error('[YouTube] Error getting broadcast status:', error);
    res.status(500).json({
      error: error.message || 'Failed to get broadcast status'
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

// Start server - Railway config
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// No HOST binding - Railway works without it
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