const express = require('express');
const app = express();

// Najprostszy możliwy endpoint
app.get('/', (req, res) => {
  res.send('Hello from Railway!');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Railway wymaga PORT ze zmiennej środowiskowej
const port = process.env.PORT || 8080;

// Railway - nie określaj hosta
const server = app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  console.log(`Environment PORT: ${process.env.PORT}`);
  console.log(`Using port: ${port}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Server closed');
  });
});