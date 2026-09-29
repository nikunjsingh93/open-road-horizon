import fs from 'node:fs';
import path from 'node:path';

// dev-only helper: POST /__save?name=foo  (body = PNG data URL) -> shots/foo.png
const saveShots = () => ({
  name: 'save-shots',
  configureServer(server) {
    server.middlewares.use('/__save', (req, res) => {
      const url = new URL(req.url, 'http://x');
      const name = (url.searchParams.get('name') || 'shot').replace(/[^\w.-]/g, '_');
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const b64 = body.replace(/^data:image\/\w+;base64,/, '');
        fs.mkdirSync(path.resolve('shots'), { recursive: true });
        fs.writeFileSync(path.resolve('shots', name + '.png'), Buffer.from(b64, 'base64'));
        res.end('ok');
      });
    });
  },
});

export default {
  base: './',
  plugins: [saveShots()],
  server: { port: 5199, host: '127.0.0.1' },
  build: { target: 'es2022' },
};
