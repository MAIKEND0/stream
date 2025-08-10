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
      message: 'Stream created successfully! Use the streamKey in your iOS app.',
      instructions: {
        step1: 'Configure your iOS app with the RTMP URL and stream key',
        step2: 'Start streaming from your iOS app to the RTMP URL',
        step3: 'Wait 5-10 seconds for stream to initialize',
        step4: 'Call /api/stream/start to go live',
        important: 'You MUST start streaming data BEFORE calling /api/stream/start'
      }
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
      console.log('[YouTube] Will check stream status every 2 seconds for up to 120 seconds');
      
      let retries = 0;
      const maxRetries = 60; // 60 checks * 2 seconds = 120 seconds total
      let streamActive = false;
      let lastHealthStatus = null;
      
      while (retries < maxRetries && !streamActive) {
        // Check stream status
        if (streamId) {
          const streamCheck = await youtube.liveStreams.list({
            id: [streamId],
            part: ['id', 'status', 'cdn']
          });
          
          if (streamCheck.data.items && streamCheck.data.items.length > 0) {
            const stream = streamCheck.data.items[0];
            const streamStatus = stream.status;
            const healthStatus = streamStatus?.healthStatus;
            
            console.log(`[YouTube] Check ${retries + 1}/${maxRetries} - Stream status:`, {
              streamStatus: streamStatus?.streamStatus,
              healthStatus: healthStatus?.status,
              lastUpdated: healthStatus?.lastUpdateTimeSeconds,
              configurationIssues: healthStatus?.configurationIssues,
              description: healthStatus?.description
            });
            
            // Check if health status changed
            if (healthStatus?.status !== lastHealthStatus) {
              console.log(`[YouTube] Health status changed: ${lastHealthStatus} -> ${healthStatus?.status}`);
              lastHealthStatus = healthStatus?.status;
            }
            
            // YouTube considers stream active when streamStatus is 'active' 
            // OR when health status is 'good' or 'ok'
            if (streamStatus?.streamStatus === 'active' || 
                healthStatus?.status === 'good' || 
                healthStatus?.status === 'ok') {
              streamActive = true;
              console.log('[YouTube] ✅ Stream is now active and receiving data!');
              break;
            }
            
            // If we have 'noData' for too long, provide helpful error
            if (retries > 10 && healthStatus?.status === 'noData') {
              console.log('[YouTube] ⚠️ Stream created but no data received. Check:');
              console.log('  1. RTMP URL: rtmp://a.rtmp.youtube.com/live2/' + (stream.cdn?.ingestionInfo?.streamName || 'STREAM_KEY'));
              console.log('  2. Stream key is correct');
              console.log('  3. iOS app is actually sending video data');
            }
          }
        }
        
        retries++;
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds between checks
      }
      
      if (!streamActive) {
        return res.status(400).json({
          error: 'Stream not active',
          details: 'The stream did not become active within 60 seconds. Please ensure:\n1. You are streaming to the correct RTMP URL\n2. Your streaming key is correct\n3. Your streaming software is actively sending data',
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

// Debug endpoint - check if stream is receiving data
app.get('/api/stream/debug/:broadcastId', async (req, res) => {
  try {
    const { broadcastId } = req.params;
    
    // Get broadcast with stream binding
    const broadcastCheck = await youtube.liveBroadcasts.list({
      id: [broadcastId],
      part: ['id', 'status', 'contentDetails', 'snippet']
    });
    
    if (!broadcastCheck.data.items?.length) {
      return res.status(404).json({ error: 'Broadcast not found' });
    }
    
    const broadcast = broadcastCheck.data.items[0];
    const streamId = broadcast.contentDetails?.boundStreamId;
    
    let streamDebugInfo = null;
    
    if (streamId) {
      const streamCheck = await youtube.liveStreams.list({
        id: [streamId],
        part: ['id', 'status', 'cdn']
      });
      
      if (streamCheck.data.items?.length) {
        const stream = streamCheck.data.items[0];
        streamDebugInfo = {
          streamId: stream.id,
          streamStatus: stream.status?.streamStatus,
          healthStatus: stream.status?.healthStatus,
          rtmpIngestionAddress: stream.cdn?.ingestionInfo?.ingestionAddress,
          rtmpStreamName: stream.cdn?.ingestionInfo?.streamName,
          backupIngestionAddress: stream.cdn?.ingestionInfo?.backupIngestionAddress,
          resolution: stream.cdn?.resolution,
          frameRate: stream.cdn?.frameRate,
          isReceivingData: stream.status?.streamStatus === 'active',
          troubleshooting: {
            ifNotActive: [
              'Ensure iOS app is using RTMP URL: ' + stream.cdn?.ingestionInfo?.ingestionAddress,
              'Stream key (streamName): ' + stream.cdn?.ingestionInfo?.streamName,
              'iOS app must be actively streaming video data',
              'Check iOS app logs for RTMP connection errors'
            ]
          }
        };
      }
    }
    
    res.json({
      broadcastId: broadcast.id,
      broadcastStatus: broadcast.status?.lifeCycleStatus,
      streamBound: !!streamId,
      streamDebugInfo,
      nextSteps: streamDebugInfo?.isReceivingData 
        ? 'Stream is active! You can call /api/stream/start' 
        : 'Stream is NOT receiving data. Check iOS app RTMP configuration.'
    });
    
  } catch (error) {
    console.error('[YouTube] Debug error:', error);
    res.status(500).json({ error: error.message });
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

// Test endpoint for hardcoded stream key
app.post('/api/stream/test-key', async (req, res) => {
  const testKey = 'c6sq-pzqy-8d5d-d2q2-d0gj';
  
  console.log('[YouTube] Testing hardcoded stream key:', testKey);
  
  try {
    // List all active streams to find one with matching key
    const streamsResponse = await youtube.liveStreams.list({
      part: ['id', 'status', 'cdn', 'snippet'],
      mine: true
    });
    
    if (!streamsResponse.data.items || streamsResponse.data.items.length === 0) {
      return res.json({
        success: false,
        message: 'No streams found for this YouTube account'
      });
    }
    
    // Find stream with matching key
    const matchingStream = streamsResponse.data.items.find(stream => 
      stream.cdn?.ingestionInfo?.streamName === testKey
    );
    
    if (matchingStream) {
      console.log('[YouTube] Found matching stream:', {
        id: matchingStream.id,
        title: matchingStream.snippet?.title,
        status: matchingStream.status?.streamStatus,
        health: matchingStream.status?.healthStatus?.status
      });
      
      // Find associated broadcast
      const broadcastsResponse = await youtube.liveBroadcasts.list({
        part: ['id', 'status', 'contentDetails', 'snippet'],
        mine: true
      });
      
      const associatedBroadcast = broadcastsResponse.data.items?.find(broadcast =>
        broadcast.contentDetails?.boundStreamId === matchingStream.id
      );
      
      res.json({
        success: true,
        stream: {
          id: matchingStream.id,
          streamKey: testKey,
          status: matchingStream.status?.streamStatus,
          health: matchingStream.status?.healthStatus,
          rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2/' + testKey
        },
        broadcast: associatedBroadcast ? {
          id: associatedBroadcast.id,
          title: associatedBroadcast.snippet?.title,
          status: associatedBroadcast.status?.lifeCycleStatus,
          watchUrl: `https://youtube.com/watch?v=${associatedBroadcast.id}`
        } : null,
        message: 'Stream key is valid! Use the RTMP URL in your iOS app.'
      });
    } else {
      res.json({
        success: false,
        message: 'Stream key not found. Available stream keys:',
        availableKeys: streamsResponse.data.items.map(s => ({
          key: s.cdn?.ingestionInfo?.streamName,
          title: s.snippet?.title,
          status: s.status?.streamStatus
        }))
      });
    }
  } catch (error) {
    console.error('[YouTube] Error testing stream key:', error);
    res.status(500).json({
      error: error.message || 'Failed to test stream key'
    });
  }
});

// Użyj istniejącego stream key (twój hardcoded key)
app.post('/api/stream/use-existing', async (req, res) => {
  const existingKey = 'c6sq-pzqy-8d5d-d2q2-d0gj'; // Aktywny klucz z YouTube
  
  try {
    console.log('[YouTube] Using existing stream key:', existingKey);
    
    // Znajdź stream z tym kluczem
    const streamsResponse = await youtube.liveStreams.list({
      part: ['id', 'status', 'cdn', 'snippet'],
      mine: true
    });
    
    const existingStream = streamsResponse.data.items?.find(stream => 
      stream.cdn?.ingestionInfo?.streamName === existingKey
    );
    
    if (!existingStream) {
      console.log('[YouTube] Stream not found, available streams:', 
        streamsResponse.data.items?.map(s => s.cdn?.ingestionInfo?.streamName));
      
      return res.status(404).json({ 
        error: 'Stream with this key not found',
        key: existingKey,
        hint: 'Create a persistent stream key in YouTube Studio',
        instruction: 'Go to YouTube Studio → Live Streaming → Stream Key'
      });
    }
    
    console.log('[YouTube] Found existing stream:', {
      id: existingStream.id,
      title: existingStream.snippet?.title,
      status: existingStream.status?.streamStatus
    });
    
    // Sprawdź czy jest już broadcast powiązany z tym streamem
    const broadcastsResponse = await youtube.liveBroadcasts.list({
      part: ['id', 'status', 'contentDetails', 'snippet'],
      mine: true,
      broadcastStatus: 'upcoming' // Szukaj tylko nadchodzących
    });
    
    // Znajdź broadcast który używa tego streamu
    let existingBroadcast = broadcastsResponse.data.items?.find(broadcast =>
      broadcast.contentDetails?.boundStreamId === existingStream.id &&
      (broadcast.status?.lifeCycleStatus === 'ready' || 
       broadcast.status?.lifeCycleStatus === 'testing')
    );
    
    if (existingBroadcast) {
      console.log('[YouTube] Found existing broadcast:', existingBroadcast.id);
      
      // Użyj istniejącego broadcast
      res.json({
        success: true,
        broadcastId: existingBroadcast.id,
        streamKey: existingKey,
        streamId: existingStream.id,
        rtmpUrl: `rtmp://a.rtmp.youtube.com/live2`,
        watchUrl: `https://youtube.com/watch?v=${existingBroadcast.id}`,
        status: existingBroadcast.status?.lifeCycleStatus,
        message: 'Using existing broadcast and stream!',
        canStartNow: existingBroadcast.status?.lifeCycleStatus === 'ready'
      });
      
    } else {
      // Utwórz nowy broadcast i powiąż z istniejącym streamem
      console.log('[YouTube] Creating new broadcast for existing stream...');
      
      const broadcast = await youtube.liveBroadcasts.insert({
        part: ['snippet', 'status', 'contentDetails'],
        requestBody: {
          snippet: {
            title: req.body.title || `eFootball Mobile - ${new Date().toLocaleDateString('pl-PL')} ${new Date().toLocaleTimeString('pl-PL')}`,
            description: req.body.description || 'Transmisja na żywo z gry eFootball Mobile',
            scheduledStartTime: new Date().toISOString()
          },
          status: {
            privacyStatus: req.body.privacy || 'public',
            selfDeclaredMadeForKids: false
          },
          contentDetails: {
            enableAutoStart: false,
            enableAutoStop: true,
            recordFromStart: true,
            monitorStream: {
              enableMonitorStream: true,
              broadcastStreamDelayMs: 0
            }
          }
        }
      });
      
      console.log('[YouTube] New broadcast created:', broadcast.data.id);
      
      // Powiąż istniejący stream z nowym broadcast
      await youtube.liveBroadcasts.bind({
        part: ['id'],
        id: broadcast.data.id,
        streamId: existingStream.id
      });
      
      console.log('[YouTube] Stream bound to broadcast successfully');
      
      res.json({
        success: true,
        broadcastId: broadcast.data.id,
        streamKey: existingKey,
        streamId: existingStream.id,
        rtmpUrl: `rtmp://a.rtmp.youtube.com/live2`,
        watchUrl: `https://youtube.com/watch?v=${broadcast.data.id}`,
        status: broadcast.data.status?.lifeCycleStatus,
        message: 'New broadcast created with existing stream key!',
        instructions: {
          step1: 'Stream is ready to receive data',
          step2: 'Start broadcasting from iOS app',
          step3: 'Wait 5-10 seconds for data to arrive',
          step4: 'Call /api/stream/start to go live'
        }
      });
    }
    
  } catch (error) {
    console.error('[YouTube] Error in use-existing:', error);
    res.status(500).json({ 
      error: error.message,
      details: error.response?.data?.error
    });
  }
});

// Dodaj też endpoint do sprawdzenia czy stream odbiera dane
app.get('/api/stream/check-data/:broadcastId', async (req, res) => {
  try {
    const { broadcastId } = req.params;
    
    // Pobierz broadcast
    const broadcastCheck = await youtube.liveBroadcasts.list({
      id: [broadcastId],
      part: ['id', 'status', 'contentDetails']
    });
    
    if (!broadcastCheck.data.items?.length) {
      return res.status(404).json({ error: 'Broadcast not found' });
    }
    
    const broadcast = broadcastCheck.data.items[0];
    const streamId = broadcast.contentDetails?.boundStreamId;
    
    if (!streamId) {
      return res.json({
        success: false,
        receivingData: false,
        message: 'No stream bound to broadcast'
      });
    }
    
    // Sprawdź status streamu
    const streamCheck = await youtube.liveStreams.list({
      id: [streamId],
      part: ['id', 'status']
    });
    
    if (!streamCheck.data.items?.length) {
      return res.json({
        success: false,
        receivingData: false,
        message: 'Stream not found'
      });
    }
    
    const stream = streamCheck.data.items[0];
    const isActive = stream.status?.streamStatus === 'active';
    const healthStatus = stream.status?.healthStatus?.status;
    
    res.json({
      success: true,
      receivingData: isActive,
      streamStatus: stream.status?.streamStatus,
      healthStatus: healthStatus,
      canGoLive: isActive && broadcast.status?.lifeCycleStatus === 'ready',
      message: isActive 
        ? '✅ Stream is receiving data! Ready to go live.'
        : '⏳ Waiting for stream data... Make sure iOS app is broadcasting.',
      debug: {
        broadcastStatus: broadcast.status?.lifeCycleStatus,
        streamId: streamId,
        lastUpdate: stream.status?.healthStatus?.lastUpdateTimeSeconds
      }
    });
    
  } catch (error) {
    console.error('[YouTube] Error checking data:', error);
    res.status(500).json({ error: error.message });
  }
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