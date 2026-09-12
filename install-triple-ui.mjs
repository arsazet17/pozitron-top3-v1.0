import fs from 'node:fs';

const VERSION='1.2.0';

let html=fs.readFileSync('index.html','utf8');
if(!html.includes('triple-methods.css')){
  html=html.replace('</head>',`  <link rel="stylesheet" href="./triple-methods.css?v=${VERSION}">\n</head>`);
}
if(!html.includes('triple-methods.js')){
  const tag=`  <script src="./triple-methods.js?v=${VERSION}"></script>\n`;
  const mirror=/(\s*<script[^>]+mirror-method\.js[^>]*><\/script>\s*)/i;
  html=mirror.test(html)?html.replace(mirror,m=>m+tag):html.replace('</body>',tag+'</body>');
}
fs.writeFileSync('index.html',html);

let app=fs.readFileSync('app.js','utf8');
app=app.replace(/const APP_VERSION\s*=\s*['"][^'"]+['"]\s*;/,`const APP_VERSION='${VERSION}';`);
fs.writeFileSync('app.js',app);

let sw=fs.readFileSync('sw.js','utf8');
sw=sw.replace(/const CACHE_NAME = ['"][^'"]+['"];?/,`const CACHE_NAME = 'yulia-top3-v1-2-0-three-methods';`);
if(!sw.includes('triple-methods.css')){
  sw=sw.replace(/('\.\/mirror-method\.css[^']*'\s*,\s*'\.\/mirror-method\.js[^']*'\s*,?)/,
    `$1\n  './triple-methods.css?v=${VERSION}', './triple-methods.js?v=${VERSION}',`);
}
fs.writeFileSync('sw.js',sw);
console.log('Triple M1/M2/M3 UI installed, version',VERSION);
