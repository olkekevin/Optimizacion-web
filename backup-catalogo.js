// Backup del catalogo de Tiendanube: productos (con categorias y variantes) + arbol de categorias.
// Genera: backups/productos-YYYY-MM-DD.json y backups/categorias-YYYY-MM-DD.json
// Uso: node backup-catalogo.js
const path = require('path');
const fs = require('fs');

try {
  const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch (_) { /* sin .env local: se usan las variables de entorno del sistema */ }

const BASE = `https://api.tiendanube.com/v1/${process.env.TN_STORE_ID}`;
const HEADERS = {
  'Authentication': `bearer ${process.env.TN_ACCESS_TOKEN}`,
  'User-Agent': 'HappyBuy Backup (olkekevin@gmail.com)',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getAll(path_) {
  const out = [];
  for (let page = 1; ; page++) {
    let r;
    for (let i = 1; ; i++) {
      r = await fetch(`${BASE}${path_}${path_.includes('?') ? '&' : '?'}per_page=200&page=${page}`, { headers: HEADERS });
      if (r.status === 429 && i < 6) { await sleep(2000 * i); continue; }
      break;
    }
    if (r.status === 404) break;
    if (!r.ok) throw new Error(`${path_} page ${page}: HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < 200) break;
  }
  return out;
}

(async () => {
  const fecha = new Date().toISOString().slice(0, 10);
  const dir = path.join(__dirname, 'backups');
  fs.mkdirSync(dir, { recursive: true });

  const categorias = await getAll('/categories');
  const fCat = path.join(dir, `categorias-${fecha}.json`);
  fs.writeFileSync(fCat, JSON.stringify(categorias, null, 2));
  console.log(`Categorias: ${categorias.length} -> ${fCat}`);

  const productos = await getAll('/products');
  const fProd = path.join(dir, `productos-${fecha}.json`);
  fs.writeFileSync(fProd, JSON.stringify(productos, null, 2));
  console.log(`Productos: ${productos.length} -> ${fProd}`);

  // Resumen compacto producto -> categorias (util para restaurar solo categorias)
  const mapa = productos.map(p => ({
    id: p.id,
    nombre: p.name?.es || '',
    categorias: (p.categories || []).map(c => c.id),
  }));
  const fMapa = path.join(dir, `producto-categorias-${fecha}.json`);
  fs.writeFileSync(fMapa, JSON.stringify(mapa, null, 2));
  console.log(`Mapa producto->categorias: ${mapa.length} -> ${fMapa}`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
