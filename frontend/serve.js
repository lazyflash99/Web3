const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || 8080;
const ROOT = __dirname;
const DEPLOYMENTS = path.join(__dirname, '..', 'deployments');

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Serve deployment JSON files
    if (req.url.startsWith('/deployments/')) {
        const file = path.join(DEPLOYMENTS, path.basename(req.url));
        return serveFile(file, res);
    }

    const safePath = path.normalize(req.url).replace(/^(\.\.[\/\\])+/, '');
    const file = path.join(ROOT, safePath === '/' || safePath === '\\' ? 'index.html' : safePath);
    if (!file.startsWith(ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
    serveFile(file, res);
});

function serveFile(filePath, res) {
    const ext = path.extname(filePath);
    const contentTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml'
    };

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end('File not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
        res.end(content);
    });
}

server.listen(PORT, () => {
    console.log(`\n🌐 Frontend server running at http://localhost:${PORT}\n`);
    console.log('Open this URL in your browser (not the file directly)');
});
