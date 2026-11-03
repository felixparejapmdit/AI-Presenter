// Gives a friendly message when a dedicated port is taken, instead of a raw Vite error.
import net from 'node:net';

const port = Number(process.argv[2] ?? 17391);
const server = net.createServer();
server.once('error', (error) => {
  if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
    console.error(`\nPort ${port} is reserved for Vanguard Deck but is already in use.`);
    console.error('Another copy of the app may still be running. Close it and try again.\n');
    process.exit(1);
  }
  throw error;
});
server.once('listening', () => server.close(() => process.exit(0)));
server.listen(port, '127.0.0.1');
