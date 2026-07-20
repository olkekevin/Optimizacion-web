// Servidor de precios en efectivo (independiente de Tiendanube).
// Expone un endpoint publico GET /precio/:sku que devuelve el precio en efectivo de ese SKU,
// y un panel simple para cargar/editar precios a mano.
// Uso: node server.js  ->  http://localhost:3011
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = 3011;
const DB_FILE = path.join(__dirname, 'precios.json');

function leerDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function guardarDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

const HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Precios en Efectivo - HappyBuy</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;background:#f4f5f7;color:#1c2430}
  header{background:#111827;color:#fff;padding:14px 22px}
  h1{font-size:18px;margin:0}
  main{max-width:640px;margin:20px auto;padding:0 16px}
  .card{background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.08);padding:16px 18px;margin-bottom:16px}
  input{padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px}
  button{background:#2563eb;color:#fff;border:0;border-radius:7px;padding:8px 14px;font-size:14px;cursor:pointer}
  table{width:100%;border-collapse:collapse;font-size:14px} td,th{padding:6px 8px;border-bottom:1px solid #eee;text-align:left}
  .danger{background:#dc2626}
</style></head><body>
<header><h1>💵 Precios en Efectivo — HappyBuy</h1></header>
<main>
  <div class="card">
    <h3>Agregar / actualizar</h3>
    <input id="sku" placeholder="SKU (ej: 13063)" style="width:140px">
    <input id="precio" placeholder="Precio (ej: 15000)" type="number" style="width:140px">
    <button onclick="guardar()">Guardar</button>
  </div>
  <div class="card">
    <h3>Precios cargados</h3>
    <table id="tabla"></table>
  </div>
</main>
<script>
async function cargar() {
  const r = await fetch('/api/precios'); const db = await r.json();
  const filas = Object.entries(db).map(([sku, precio]) =>
    '<tr><td>' + sku + '</td><td>$' + Number(precio).toLocaleString('es-AR') + '</td><td><button class="danger" onclick="borrar(\\'' + sku + '\\')">Borrar</button></td></tr>').join('');
  document.getElementById('tabla').innerHTML = '<tr><th>SKU</th><th>Precio</th><th></th></tr>' + filas;
}
async function guardar() {
  const sku = document.getElementById('sku').value.trim();
  const precio = document.getElementById('precio').value.trim();
  if (!sku || !precio) return alert('Completá SKU y precio');
  await fetch('/api/precios', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ sku, precio }) });
  document.getElementById('sku').value = ''; document.getElementById('precio').value = '';
  cargar();
}
async function borrar(sku) {
  await fetch('/api/precios/' + encodeURIComponent(sku), { method: 'DELETE' });
  cargar();
}
cargar();
</script></body></html>`;

const server = http.createServer((req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }

  // Endpoint publico que va a llamar el script en la tienda
  if (req.method === 'GET' && req.url.startsWith('/precio/')) {
    const sku = decodeURIComponent(req.url.split('/precio/')[1] || '').trim();
    const db = leerDB();
    if (db[sku] === undefined) return json(404, { error: 'sin precio en efectivo para este SKU' });
    return json(200, { sku, precio: db[sku] });
  }

  if (req.method === 'GET' && req.url === '/api/precios') return json(200, leerDB());

  if (req.method === 'POST' && req.url === '/api/precios') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { sku, precio } = JSON.parse(body);
      const db = leerDB();
      db[sku.trim()] = Number(precio);
      guardarDB(db);
      json(200, { ok: true });
    });
    return;
  }

  if (req.method === 'DELETE' && req.url.startsWith('/api/precios/')) {
    const sku = decodeURIComponent(req.url.split('/api/precios/')[1] || '');
    const db = leerDB();
    delete db[sku];
    guardarDB(db);
    return json(200, { ok: true });
  }

  json(404, { error: 'no encontrado' });
});

server.listen(PORT, () => console.log(`Precios en Efectivo: http://localhost:${PORT}`));
