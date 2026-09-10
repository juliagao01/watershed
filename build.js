/* Inlines CSS + JS into dist/index.html (artifact-ready: no doctype/html/head/body tags). */
const fs = require('fs'), path = require('path');
const ROOT = __dirname;
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="(src\/[^"]+)"><\/script>/g)].map(m => m[1]);
const css = fs.readFileSync(path.join(ROOT, 'src/ui/style.css'), 'utf8');
let out = '<meta charset="utf-8">\n<title>Watershed</title>\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<style>\n' + css + '\n</style>\n';
out += '<div id="app"><div id="canvas-host"></div><div id="ui"></div></div>\n';
out += '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>\n';
for (const s of scripts) {
  const code = fs.readFileSync(path.join(ROOT, s), 'utf8').replace(/<\/script>/gi, '<\\/script>');
  out += '<script>/* ' + s + ' */\n' + code + '\n</script>\n';
}
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist/index.html'), out);
console.log('built dist/index.html', (out.length / 1024).toFixed(0) + ' KB', scripts.length + ' scripts');
