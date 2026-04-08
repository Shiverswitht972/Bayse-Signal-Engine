import http from 'http';

const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.writeHead(200);
    res.end('Bayse Signal Engine running');
  })
  .listen(PORT, () => {
    console.log(`Health server on port ${PORT}`);
  });
