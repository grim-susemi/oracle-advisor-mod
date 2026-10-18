import { createServer } from 'node:net';

const mode = process.argv[2];
if (mode === 'misleading-success') {
  console.log('success');
  process.exitCode = 7;
} else if (mode === 'hang' || mode === 'ready') {
  createServer().listen(0, '127.0.0.1', () => {
    if (mode === 'ready') console.log(JSON.stringify({
      type: 'ready', path_present: Object.keys(process.env).some(key => key.toLowerCase() === 'path'),
    }));
  });
} else throw new Error('Unknown owned process fixture mode');
