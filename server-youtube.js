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
    const rtmpUrl = stream.data.cdn?.ingestionInfo?.ingestionAddress || 'rtmps://a.rtmps.youtube.com/live2';
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
              console.log('  1. RTMP URL: rtmps://a.rtmps.youtube.com/live2/' + (stream.cdn?.ingestionInfo?.streamName || 'STREAM_KEY'));
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
            rtmpUrl: 'rtmps://a.rtmps.youtube.com/live2',
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

// Removed duplicate GET /api/stream/status/:broadcastId - using the one at line ~1570 instead

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
  const testKey = 'q0e0-ruge-wse6-y53r-2vt1';
  
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
          rtmpUrl: 'rtmps://a.rtmps.youtube.com/live2/' + testKey
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
  const existingKey = 'q0e0-ruge-wse6-y53r-2vt1'; // Aktywny klucz z YouTube
  
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
      mine: true
      // Usunięto broadcastStatus - nie można używać razem z mine
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
        rtmpUrl: `rtmps://a.rtmps.youtube.com/live2`,
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
        rtmpUrl: `rtmps://a.rtmps.youtube.com/live2`,
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

// Force recreate stream with the same key
app.post('/api/stream/force-recreate', async (req, res) => {
  const existingKey = 'q0e0-ruge-wse6-y53r-2vt1';
  
  try {
    console.log('[YouTube] Force recreating stream and broadcast...');
    
    // Step 1: Clean up any existing broadcasts in ready/testing state
    const broadcastsResponse = await youtube.liveBroadcasts.list({
      part: ['id', 'status', 'contentDetails'],
      mine: true
    });
    
    for (const broadcast of (broadcastsResponse.data.items || [])) {
      if (broadcast.status?.lifeCycleStatus === 'ready' || 
          broadcast.status?.lifeCycleStatus === 'testing') {
        try {
          // Try to delete or complete the broadcast
          await youtube.liveBroadcasts.delete({
            id: broadcast.id
          });
          console.log(`[YouTube] Deleted old broadcast: ${broadcast.id}`);
        } catch (e) {
          console.log(`[YouTube] Could not delete broadcast ${broadcast.id}: ${e.message}`);
        }
      }
    }
    
    // Step 2: Create a fresh broadcast
    const broadcast = await youtube.liveBroadcasts.insert({
      part: ['snippet', 'status', 'contentDetails'],
      requestBody: {
        snippet: {
          title: req.body.title || `eFootball Mobile - ${new Date().toLocaleDateString('pl-PL')} ${new Date().toLocaleTimeString('pl-PL')}`,
          description: req.body.description || 'Transmisja na żywo z gry eFootball Mobile',
          scheduledStartTime: new Date().toISOString() // Start immediately
        },
        status: {
          privacyStatus: 'public',
          selfDeclaredMadeForKids: false
        },
        contentDetails: {
          enableAutoStart: true,  // KEY CHANGE: Auto-start when stream is detected
          enableAutoStop: false,   // Don't auto-stop
          recordFromStart: true,
          monitorStream: {
            enableMonitorStream: true,
            broadcastStreamDelayMs: 0
          },
          latencyPreference: 'low' // Low latency mode
        }
      }
    });
    
    console.log('[YouTube] New broadcast created:', broadcast.data.id);
    
    // Step 3: Find the stream with the hardcoded key
    const streamsResponse = await youtube.liveStreams.list({
      part: ['id', 'cdn', 'status'],
      mine: true
    });
    
    const existingStream = streamsResponse.data.items?.find(stream => 
      stream.cdn?.ingestionInfo?.streamName === existingKey
    );
    
    if (!existingStream) {
      // If no stream exists with this key, create one
      console.log('[YouTube] Creating new stream (YouTube will assign key)...');
      const newStream = await youtube.liveStreams.insert({
        part: ['snippet', 'cdn', 'status'],
        requestBody: {
          snippet: {
            title: 'eFootball Mobile Stream',
            description: 'Persistent stream for eFootball Mobile'
          },
          cdn: {
            frameRate: '30fps',
            ingestionType: 'rtmp',
            resolution: '720p'
            // YouTube will generate streamName automatically
          }
        }
      });
      
      // Get the actual generated stream key
      const generatedKey = newStream.data.cdn?.ingestionInfo?.streamName;
      console.log('[YouTube] New stream created with key:', generatedKey);
      
      // Bind new stream to broadcast
      await youtube.liveBroadcasts.bind({
        part: ['id'],
        id: broadcast.data.id,
        streamId: newStream.data.id
      });
      
      console.log('[YouTube] Created and bound new stream');
    } else {
      // Bind existing stream to new broadcast
      await youtube.liveBroadcasts.bind({
        part: ['id'],
        id: broadcast.data.id,
        streamId: existingStream.id
      });
      
      console.log('[YouTube] Bound existing stream to new broadcast');
    }
    
    // Get the final stream key (either existing or newly generated)
    let finalStreamKey = existingKey;
    if (!existingStream) {
      // If we created a new stream, get its generated key
      const boundStreamId = broadcast.data.contentDetails?.boundStreamId;
      const streamCheck = await youtube.liveStreams.list({
        id: [boundStreamId],
        part: ['cdn']
      });
      finalStreamKey = streamCheck.data.items?.[0]?.cdn?.ingestionInfo?.streamName || existingKey;
    }
    
    res.json({
      success: true,
      broadcastId: broadcast.data.id,
      streamKey: finalStreamKey,
      rtmpUrl: 'rtmps://a.rtmps.youtube.com/live2',
      watchUrl: `https://youtube.com/watch?v=${broadcast.data.id}`,
      message: 'Fresh broadcast created! Stream will auto-start when data is received.',
      instructions: {
        step1: '✅ Broadcast is ready with auto-start enabled',
        step2: '⚠️ Update iOS to use this stream key',
        step3: '✅ YouTube will automatically go live when stream is detected',
        step4: 'If not live in 10 seconds, restart the iOS broadcast'
      }
    });
    
  } catch (error) {
    console.error('[YouTube] Force recreate error:', error);
    res.status(500).json({ 
      error: error.message,
      details: error.response?.data?.error
    });
  }
});

// Improved start stream endpoint with better error handling
app.post('/api/stream/start-simplified', async (req, res) => {
  const { broadcastId } = req.body;
  
  try {
    console.log('[YouTube] Simplified start for broadcast:', broadcastId);
    
    // Skip all the checking and just try to transition
    // YouTube will handle the validation
    
    // Try to go directly to live
    try {
      const response = await youtube.liveBroadcasts.transition({
        id: broadcastId,
        broadcastStatus: 'live',
        part: ['id', 'status']
      });
      
      console.log('[YouTube] Successfully transitioned to live!');
      
      return res.json({
        success: true,
        status: response.data.status?.lifeCycleStatus,
        message: '🎉 Stream is now LIVE on YouTube!'
      });
      
    } catch (directError) {
      // If direct transition fails, try testing first
      console.log('[YouTube] Direct to live failed, trying testing first...');
      
      try {
        await youtube.liveBroadcasts.transition({
          id: broadcastId,
          broadcastStatus: 'testing',
          part: ['id', 'status']
        });
        
        console.log('[YouTube] Transitioned to testing, waiting 2 seconds...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Now try live
        const liveResponse = await youtube.liveBroadcasts.transition({
          id: broadcastId,
          broadcastStatus: 'live',
          part: ['id', 'status']
        });
        
        return res.json({
          success: true,
          status: liveResponse.data.status?.lifeCycleStatus,
          message: '🎉 Stream is now LIVE on YouTube!'
        });
        
      } catch (testingError) {
        throw testingError;
      }
    }
    
  } catch (error) {
    console.error('[YouTube] Start simplified error:', error);
    
    // Check if it's already live
    if (error.message?.includes('redundantTransition')) {
      return res.json({
        success: true,
        message: 'Stream is already live!'
      });
    }
    
    res.status(400).json({
      error: error.message || 'Failed to start stream',
      details: error.response?.data?.error,
      hint: 'Try using /api/stream/force-recreate to create a fresh broadcast'
    });
  }
});

// Endpoint do sprawdzenia wszystkich stream keys
app.get('/api/stream/list-keys', async (req, res) => {
  try {
    const streams = await youtube.liveStreams.list({
      part: ['id', 'cdn', 'status', 'snippet'],
      mine: true,
      maxResults: 10
    });
    
    const streamKeys = streams.data.items?.map(stream => ({
      streamId: stream.id,
      title: stream.snippet?.title,
      streamKey: stream.cdn?.ingestionInfo?.streamName,
      streamStatus: stream.status?.streamStatus,
      healthStatus: stream.status?.healthStatus?.status,
      isActive: stream.status?.streamStatus === 'active',
      rtmpUrl: `${stream.cdn?.ingestionInfo?.ingestionAddress}/${stream.cdn?.ingestionInfo?.streamName}`
    })) || [];
    
    res.json({
      totalStreams: streamKeys.length,
      streams: streamKeys,
      activeKeys: streamKeys.filter(s => s.isActive).map(s => s.streamKey),
      expectedKey: 'q0e0-ruge-wse6-y53r-2vt1',
      keyExists: streamKeys.some(s => s.streamKey === 'q0e0-ruge-wse6-y53r-2vt1')
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Quick diagnostic endpoint
app.get('/api/stream/diagnose', async (req, res) => {
  try {
    // List all broadcasts
    const broadcasts = await youtube.liveBroadcasts.list({
      part: ['id', 'status', 'snippet', 'contentDetails'],
      mine: true
    });
    
    // List all streams
    const streams = await youtube.liveStreams.list({
      part: ['id', 'cdn', 'status'],
      mine: true
    });
    
    const streamKey = 'q0e0-ruge-wse6-y53r-2vt1';
    const activeStream = streams.data.items?.find(s => 
      s.cdn?.ingestionInfo?.streamName === streamKey
    );
    
    const activeBroadcasts = broadcasts.data.items?.filter(b => 
      b.status?.lifeCycleStatus === 'ready' || 
      b.status?.lifeCycleStatus === 'testing' ||
      b.status?.lifeCycleStatus === 'live'
    );
    
    res.json({
      streamKeyStatus: activeStream ? {
        found: true,
        streamId: activeStream.id,
        status: activeStream.status?.streamStatus,
        health: activeStream.status?.healthStatus?.status,
        isActive: activeStream.status?.streamStatus === 'active'
      } : {
        found: false,
        message: 'Stream with hardcoded key not found'
      },
      
      activeBroadcasts: activeBroadcasts?.map(b => ({
        id: b.id,
        title: b.snippet?.title,
        status: b.status?.lifeCycleStatus,
        boundStreamId: b.contentDetails?.boundStreamId,
        watchUrl: `https://youtube.com/watch?v=${b.id}`,
        autoStartEnabled: b.contentDetails?.enableAutoStart
      })) || [],
      
      totalBroadcasts: broadcasts.data.items?.length || 0,
      totalStreams: streams.data.items?.length || 0,
      
      recommendations: [
        activeStream?.status?.streamStatus !== 'active' ? 
          '⚠️ Stream not active - iOS app may need to restart broadcast' : 
          '✅ Stream is active',
        
        activeBroadcasts?.length === 0 ? 
          '⚠️ No active broadcasts - use /api/stream/force-recreate' : 
          '✅ Active broadcast found',
        
        activeStream && activeBroadcasts?.some(b => b.contentDetails?.boundStreamId === activeStream.id) ?
          '✅ Stream is bound to a broadcast' :
          '⚠️ Stream not bound to any broadcast'
      ]
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint do utworzenia nowego persistent stream jeśli nie istnieje
app.post('/api/stream/create-persistent', async (req, res) => {
  const PERSISTENT_KEY = 'q0e0-ruge-wse6-y53r-2vt1';
  
  try {
    console.log('[YouTube] Creating new persistent stream with key:', PERSISTENT_KEY);
    
    // Sprawdź czy stream już istnieje
    const existingStreams = await youtube.liveStreams.list({
      part: ['id', 'cdn', 'status'],
      mine: true
    });
    
    const exists = existingStreams.data.items?.find(s => 
      s.cdn?.ingestionInfo?.streamName === PERSISTENT_KEY
    );
    
    if (exists) {
      return res.json({
        success: true,
        message: 'Stream already exists',
        streamId: exists.id,
        streamKey: PERSISTENT_KEY
      });
    }
    
    // Utwórz nowy stream z określonym kluczem
    // UWAGA: YouTube może nie pozwolić na własny klucz
    const newStream = await youtube.liveStreams.insert({
      part: ['snippet', 'cdn', 'status'],
      requestBody: {
        snippet: {
          title: 'eFootball Persistent Stream',
          description: 'Persistent stream for eFootball Mobile'
        },
        cdn: {
          frameRate: '30fps',
          ingestionType: 'rtmp',
          resolution: '720p'
        }
      }
    });
    
    res.json({
      success: true,
      message: 'New stream created',
      streamId: newStream.data.id,
      streamKey: newStream.data.cdn?.ingestionInfo?.streamName,
      note: 'YouTube generates its own stream key, cannot set custom key'
    });
    
  } catch (error) {
    console.error('[YouTube] Create persistent error:', error);
    res.status(500).json({ error: error.message });
  }
});

// NOWY ENDPOINT - użyj persistent stream key
app.post('/api/stream/use-persistent-key', async (req, res) => {
  const PERSISTENT_KEY = 'q0e0-ruge-wse6-y53r-2vt1'; // NAPRAWIONO: Zgodny z iOS
  
  try {
    console.log('[YouTube] Using persistent stream key');
    
    // Znajdź stream z tym kluczem
    const streamsResponse = await youtube.liveStreams.list({
      part: ['id', 'status', 'cdn', 'snippet'],
      mine: true
    });
    
    const persistentStream = streamsResponse.data.items?.find(stream => 
      stream.cdn?.ingestionInfo?.streamName === PERSISTENT_KEY
    );
    
    if (!persistentStream) {
      return res.status(404).json({
        error: 'Stream with this key not found',
        providedKey: PERSISTENT_KEY,
        hint: 'Check if the stream key is correct in YouTube Studio'
      });
    }
    
    console.log('[YouTube] Found persistent stream:', persistentStream.id);
    
    // Sprawdź istniejące broadcasty
    const broadcastsResponse = await youtube.liveBroadcasts.list({
      part: ['id', 'status', 'contentDetails', 'snippet'],
      mine: true,
      maxResults: 10
    });
    
    // Znajdź broadcast powiązany z tym streamem
    let activeBroadcast = broadcastsResponse.data.items?.find(broadcast =>
      broadcast.contentDetails?.boundStreamId === persistentStream.id &&
      (broadcast.status?.lifeCycleStatus === 'ready' || 
       broadcast.status?.lifeCycleStatus === 'testing' ||
       broadcast.status?.lifeCycleStatus === 'live')
    );
    
    if (activeBroadcast && activeBroadcast.status?.lifeCycleStatus === 'live') {
      return res.json({
        success: true,
        broadcastId: activeBroadcast.id,
        streamKey: PERSISTENT_KEY,
        status: 'live',
        message: 'Stream is already LIVE!',
        watchUrl: `https://youtube.com/watch?v=${activeBroadcast.id}`
      });
    }
    
    // Utwórz nowy broadcast jeśli potrzebny
    if (!activeBroadcast || activeBroadcast.status?.lifeCycleStatus === 'complete') {
      console.log('[YouTube] Creating new broadcast...');
      
      const broadcast = await youtube.liveBroadcasts.insert({
        part: ['snippet', 'status', 'contentDetails'],
        requestBody: {
          snippet: {
            title: `eFootball Mobile - ${new Date().toLocaleString('pl-PL')}`,
            description: req.body.description || 'Transmisja na żywo z gry eFootball Mobile',
            scheduledStartTime: new Date().toISOString()
          },
          status: {
            privacyStatus: 'public',
            selfDeclaredMadeForKids: false
          },
          contentDetails: {
            enableAutoStart: true,
            enableAutoStop: false,
            recordFromStart: true,
            monitorStream: {
              enableMonitorStream: true,
              broadcastStreamDelayMs: 0
            },
            latencyPreference: 'low'
          }
        }
      });
      
      console.log('[YouTube] New broadcast created:', broadcast.data.id);
      
      // Powiąż stream
      await youtube.liveBroadcasts.bind({
        part: ['id'],
        id: broadcast.data.id,
        streamId: persistentStream.id
      });
      
      activeBroadcast = broadcast.data;
    }
    
    res.json({
      success: true,
      broadcastId: activeBroadcast.id,
      streamKey: PERSISTENT_KEY,
      streamId: persistentStream.id,
      rtmpUrl: 'rtmps://a.rtmps.youtube.com/live2',
      watchUrl: `https://youtube.com/watch?v=${activeBroadcast.id}`,
      status: activeBroadcast.status?.lifeCycleStatus,
      message: 'Broadcast ready! Stream will auto-start when data is detected.'
    });
    
  } catch (error) {
    console.error('[YouTube] Error:', error);
    res.status(500).json({ 
      error: error.message,
      details: error.response?.data?.error
    });
  }
});

// NOWY ENDPOINT - Wymuś przejście do live
app.post('/api/stream/force-live', async (req, res) => {
  const { broadcastId } = req.body;
  
  if (!broadcastId) {
    return res.status(400).json({ error: 'broadcastId required' });
  }
  
  try {
    console.log('[YouTube] FORCING transition to live for:', broadcastId);
    
    // Sprawdź status
    const check = await youtube.liveBroadcasts.list({
      id: [broadcastId],
      part: ['id', 'status', 'contentDetails']
    });
    
    if (!check.data.items?.length) {
      return res.status(404).json({ error: 'Broadcast not found' });
    }
    
    const broadcast = check.data.items[0];
    const currentStatus = broadcast.status?.lifeCycleStatus;
    
    console.log('[YouTube] Current status:', currentStatus);
    
    if (currentStatus === 'live') {
      return res.json({
        success: true,
        message: 'Already LIVE!',
        status: 'live'
      });
    }
    
    // Spróbuj przejść do live
    try {
      // Najpierw do testing jeśli w ready
      if (currentStatus === 'ready') {
        await youtube.liveBroadcasts.transition({
          id: broadcastId,
          broadcastStatus: 'testing',
          part: ['id', 'status']
        });
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      // Teraz do live
      await youtube.liveBroadcasts.transition({
        id: broadcastId,
        broadcastStatus: 'live',
        part: ['id', 'status']
      });
      
      return res.json({
        success: true,
        message: '🎉 Stream is now LIVE!',
        status: 'live'
      });
      
    } catch (transitionError) {
      // Szczegółowa diagnostyka dlaczego nie można przejść do live
      const streamId = broadcast.contentDetails?.boundStreamId;
      let streamInfo = null;
      let streamDetails = null;
      
      if (streamId) {
        const streamCheck = await youtube.liveStreams.list({
          id: [streamId],
          part: ['id', 'status', 'cdn']
        });
        streamDetails = streamCheck.data.items?.[0];
        streamInfo = streamDetails?.status;
      }
      
      console.log('[YouTube] Transition failed - Stream diagnostics:', {
        streamId,
        streamStatus: streamInfo?.streamStatus,
        healthStatus: streamInfo?.healthStatus?.status,
        expectedStreamKey: streamDetails?.cdn?.ingestionInfo?.streamName,
        rtmpUrl: streamDetails?.cdn?.ingestionInfo?.ingestionAddress
      });
      
      return res.status(400).json({
        error: 'Cannot transition to live',
        currentStatus: currentStatus,
        streamDiagnostics: {
          streamId,
          streamStatus: streamInfo?.streamStatus,                    // 'active' | 'inactive' | 'created'
          healthStatus: streamInfo?.healthStatus?.status,           // 'noData' | 'good' | 'ok'
          expectedStreamKey: streamDetails?.cdn?.ingestionInfo?.streamName,
          expectedRtmpUrl: `${streamDetails?.cdn?.ingestionInfo?.ingestionAddress}/${streamDetails?.cdn?.ingestionInfo?.streamName}`,
          lastHealthUpdate: streamInfo?.healthStatus?.lastUpdateTimeSeconds
        },
        hint: streamInfo?.healthStatus?.status === 'noData' 
          ? `iOS nie wysyła danych na stream key: ${streamDetails?.cdn?.ingestionInfo?.streamName}. Sprawdź czy extension używa właściwego klucza.`
          : `Status: ${streamInfo?.streamStatus}, Health: ${streamInfo?.healthStatus?.status}. Odczekaj chwilę i spróbuj ponownie.`,
        troubleshooting: [
          `Expected stream key: ${streamDetails?.cdn?.ingestionInfo?.streamName}`,
          `Expected RTMP URL: ${streamDetails?.cdn?.ingestionInfo?.ingestionAddress}`,
          'Sprawdź logi iOS extension - czy używa tego samego stream key?',
          'Zatrzymaj i uruchom ponownie broadcast na iOS',
          'Poczekaj 10-15 sekund po rozpoczęciu broadcastu zanim klikniesz force-live'
        ]
      });
    }
    
  } catch (error) {
    console.error('[YouTube] Force live error:', error);
    res.status(500).json({
      error: error.message,
      details: error.response?.data?.error
    });
  }
});

// ENDPOINT - Sprawdź status konkretnego broadcastu
app.get('/api/stream/status/:broadcastId', async (req, res) => {
  const { broadcastId } = req.params;
  
  try {
    // Pobierz broadcast
    const broadcastCheck = await youtube.liveBroadcasts.list({
      id: [broadcastId],
      part: ['id', 'status', 'contentDetails', 'snippet']
    });
    
    if (!broadcastCheck.data.items?.length) {
      return res.status(404).json({ error: 'Broadcast not found' });
    }
    
    const broadcast = broadcastCheck.data.items[0];
    const streamId = broadcast.contentDetails?.boundStreamId;
    
    let streamDetails = null;
    if (streamId) {
      const streamCheck = await youtube.liveStreams.list({
        id: [streamId],
        part: ['id', 'status', 'cdn']
      });
      streamDetails = streamCheck.data.items?.[0];
    }
    
    res.json({
      broadcastId: broadcast.id,
      title: broadcast.snippet?.title,
      broadcastStatus: broadcast.status?.lifeCycleStatus,
      watchUrl: `https://youtube.com/watch?v=${broadcast.id}`,
      stream: streamDetails ? {
        streamId: streamDetails.id,
        streamStatus: streamDetails.status?.streamStatus,
        healthStatus: streamDetails.status?.healthStatus?.status,
        lastHealthUpdate: streamDetails.status?.healthStatus?.lastUpdateTimeSeconds,
        expectedStreamKey: streamDetails.cdn?.ingestionInfo?.streamName,
        rtmpUrl: streamDetails.cdn?.ingestionInfo?.ingestionAddress,
        isReceivingData: streamDetails.status?.streamStatus === 'active'
      } : null,
      canGoLive: broadcast.status?.lifeCycleStatus === 'ready' && 
                 streamDetails?.status?.streamStatus === 'active',
      recommendations: [
        broadcast.status?.lifeCycleStatus !== 'ready' 
          ? `Broadcast status is ${broadcast.status?.lifeCycleStatus}, expected 'ready'`
          : null,
        !streamDetails 
          ? 'No stream bound to broadcast'
          : null,
        streamDetails?.status?.streamStatus !== 'active'
          ? `Stream status is ${streamDetails?.status?.streamStatus}, expected 'active'`
          : null,
        streamDetails?.status?.healthStatus?.status === 'noData'
          ? `No data received on stream key: ${streamDetails?.cdn?.ingestionInfo?.streamName}`
          : null
      ].filter(Boolean)
    });
    
  } catch (error) {
    console.error('[YouTube] Status check error:', error);
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