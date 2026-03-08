const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;

const server = http.createServer((req, res) => {
    // API endpoint to serve deployment info
    const deploymentMatch = req.url.match(/^\/api\/deployments\/(.+)$/);
    if (deploymentMatch) {
        const network = deploymentMatch[1];
        const deploymentFile = path.join(__dirname, '..', 'deployments', `${network}.json`);

        res.setHeader('Access-Control-Allow-Origin', '*');

        fs.readFile(deploymentFile, (err, content) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `No deployment found for network: ${network}` }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(content);
        });
        return;
    }

    let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);

    const ext = path.extname(filePath);
    const contentTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json'
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
});

server.listen(PORT, () => {
    console.log(`\n🌐 Frontend server running at http://localhost:${PORT}\n`);
    console.log('Open this URL in your browser (not the file directly)');
});
