const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  console.log(`Request: ${req.method} ${req.url}`);
  
  if (req.url === '/health' || req.url === '/healthz' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`Ultra simple server listening on port ${PORT}`);
});