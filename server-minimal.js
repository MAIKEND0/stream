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

// Nasłuchuj na wszystkich interfejsach dla Railway
const server = app.listen(port, '::', () => {
  console.log(`Server is running on port ${port}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Server closed');
  });
});