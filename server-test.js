const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Simple test endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'Test server working!',
    port: process.env.PORT || 3000,
    env: {
      hasYoutubeClientId: !!process.env.YOUTUBE_CLIENT_ID,
      hasYoutubeSecret: !!process.env.YOUTUBE_CLIENT_SECRET,
      hasAccessToken: !!process.env.YOUTUBE_ACCESS_TOKEN,
      hasRefreshToken: !!process.env.YOUTUBE_REFRESH_TOKEN
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Test YouTube credentials
app.get('/test-youtube', (req, res) => {
  try {
    const hasGoogleapis = false; // Don't use googleapis yet
    res.json({
      success: true,
      credentials: {
        clientId: process.env.YOUTUBE_CLIENT_ID ? 'Set ✅' : 'Missing ❌',
        clientSecret: process.env.YOUTUBE_CLIENT_SECRET ? 'Set ✅' : 'Missing ❌',
        accessToken: process.env.YOUTUBE_ACCESS_TOKEN ? 'Set ✅' : 'Missing ❌',
        refreshToken: process.env.YOUTUBE_REFRESH_TOKEN ? 'Set ✅' : 'Missing ❌',
      }
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Test server running on port ${PORT}`);
  console.log(`📡 Railway domain: ${process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost'}`);
});