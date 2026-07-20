// Mantenimiento semanal de categorias HappyBuy (Tiendanube)
// Uso: node server.js  ->  http://localhost:3010
// Sin dependencias externas (solo Node >= 18).
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Carga .env local si existe (desarrollo). En produccion (Render/Railway/etc.)
// las variables ya vienen seteadas por el hosting y este archivo no existe.
try {
  const envText = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch (_) { /* sin .env local: se usan las variables de entorno del sistema */ }

if (!process.env.TN_ACCESS_TOKEN || !process.env.TN_STORE_ID) {
  console.error('Faltan TN_ACCESS_TOKEN / TN_STORE_ID. Crea un .env (ver .env.example) o configuralas en el hosting.');
  process.exit(1);
}

const BASE = `https://api.tiendanube.com/v1/${process.env.TN_STORE_ID}`;
const HEADERS = {
  'Authentication': `bearer ${process.env.TN_ACCESS_TOKEN}`,
  'User-Agent': 'HappyBuy Mantenimiento (olkekevin@gmail.com)',
  'Content-Type': 'application/json',
};
const PORT = process.env.PORT || 3010;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(p, opts = {}) {
  for (let i = 1; ; i++) {
    const r = await fetch(`${BASE}${p}`, { headers: HEADERS, ...opts });
    if (r.status === 429 && i < 6) { await sleep(2000 * i); continue; }
    const text = await r.text();
    if (!r.ok && r.status !== 404) throw new Error(`${opts.method || 'GET'} ${p}: HTTP ${r.status} ${text.slice(0, 200)}`);
    return { status: r.status, data: text ? JSON.parse(text) : null };
  }
}

async function getAll(p) {
  const out = [];
  for (let page = 1; ; page++) {
    const { status, data } = await api(`${p}${p.includes('?') ? '&' : '?'}per_page=200&page=${page}`);
    if (status === 404 || !Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < 200) break;
  }
  return out;
}

const nombre = c => (c.name && (c.name.es || Object.values(c.name)[0])) || '(sin nombre)';
const handle = c => (c.handle && (c.handle.es || Object.values(c.handle)[0])) || '';
const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// ---------- Usuarios y sesiones ----------
const USERS_FILE = path.join(__dirname, 'usuarios.json');
const sesiones = new Map(); // token -> { username, role }

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verificarPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
}
function leerUsuarios() {
  if (!fs.existsSync(USERS_FILE)) {
    const { salt, hash } = hashPassword('Aa37481891');
    const inicial = { kevin: { salt, hash, role: 'admin' } };
    fs.writeFileSync(USERS_FILE, JSON.stringify(inicial, null, 2));
    return inicial;
  }
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}
function guardarUsuarios(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }

function getCookie(req, nombre) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|; )' + nombre + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function sesionActual(req) {
  const token = getCookie(req, 'sesion');
  return token ? sesiones.get(token) : null;
}

// ---------- Categorias de precio (Mochilas) ----------
const MOCHILAS_ROOT = 34015480;
const CARTUCHERAS_ID = 34634705;
const DESC_TRANSFERENCIA = 0.15;
const RANGOS_PRECIO = [
  { nombre: 'Menos de $10.000', handle: 'mochilas-menos-de-10000', min: 0, max: 10000 },
  { nombre: '$10.000 a $15.000', handle: 'mochilas-10000-a-15000', min: 10000, max: 15000 },
];

async function actualizarPreciosMochilas() {
  const cats = await getAll('/categories');
  for (const rango of RANGOS_PRECIO) {
    let cat = cats.find(c => handle(c) === rango.handle);
    if (!cat) {
      const { data } = await api('/categories', {
        method: 'POST',
        body: JSON.stringify({ name: { es: rango.nombre }, handle: { es: rango.handle }, parent: MOCHILAS_ROOT }),
      });
      cat = data;
      cats.push(cat);
    }
    rango.catId = cat.id;
  }

  const prods = await getAll(`/products?category_id=${MOCHILAS_ROOT}&fields=id,name,categories,variants`);
  const resumen = Object.fromEntries(RANGOS_PRECIO.map(r => [r.handle, { agregadas: 0, sacadas: 0 }]));
  for (const p of prods) {
    // Precio de pagina = el que ve el cliente: promocional si existe, si no el de lista.
    // Solo variantes CON STOCK: una promo en una variante sin stock no es comprable y no debe definir el precio.
    const variantesComprables = (p.variants || []).filter(v => (v.stock === null || v.stock > 0));
    const fuente = variantesComprables.length > 0 ? variantesComprables : (p.variants || []);
    const precios = fuente.map(v => parseFloat(v.promotional_price || v.price)).filter(n => !isNaN(n));
    if (precios.length === 0) continue;
    const minPrecio = Math.min(...precios);
    const precioTransferencia = minPrecio * (1 - DESC_TRANSFERENCIA);
    const esCartuchera = p.categories.some(c => c.id === CARTUCHERAS_ID);

    let ids = p.categories.map(c => c.id);
    let cambio = false;
    for (const rango of RANGOS_PRECIO) {
      const deberia = !esCartuchera && precioTransferencia >= rango.min && (rango.max === null || precioTransferencia < rango.max);
      const esta = ids.includes(rango.catId);
      if (esta === deberia) continue;
      cambio = true;
      if (deberia) { ids.push(rango.catId); resumen[rango.handle].agregadas++; }
      else { ids = ids.filter(id => id !== rango.catId); resumen[rango.handle].sacadas++; }
    }
    if (cambio) {
      await api(`/products/${p.id}`, { method: 'PUT', body: JSON.stringify({ categories: [...new Set(ids)] }) });
      await sleep(350);
    }
  }

  const resultado = [];
  for (const rango of RANGOS_PRECIO) {
    const { data: fin } = await api(`/products?category_id=${rango.catId}&per_page=200&fields=id`);
    const r = resumen[rango.handle];
    resultado.push({ nombre: rango.nombre, agregadas: r.agregadas, sacadas: r.sacadas, total: fin.length });
  }
  return resultado;
}

// ---------- Analisis ----------
async function analizar() {
  const cats = await getAll('/categories');
  const productos = await getAll('/products?fields=id,name,published,categories,variants');

  const directos = {}, visibles = {};
  let sinCategoria = 0;
  for (const p of productos) {
    const stock = (p.variants || []).reduce((s, v) => s + (v.stock === null ? 1e9 : v.stock), 0);
    const visible = p.published && stock > 0;
    if (!p.categories || p.categories.length === 0) sinCategoria++;
    for (const c of (p.categories || [])) {
      directos[c.id] = (directos[c.id] || 0) + 1;
      if (visible) visibles[c.id] = (visibles[c.id] || 0) + 1;
    }
  }

  const hijosDe = {};
  cats.forEach(c => { (hijosDe[c.parent || 0] ||= []).push(c); });
  const totalCon = c => (directos[c.id] || 0) + (hijosDe[c.id] || []).reduce((s, h) => s + totalCon(h), 0);
  const visCon = c => (visibles[c.id] || 0) + (hijosDe[c.id] || []).reduce((s, h) => s + visCon(h), 0);

  const info = c => ({
    id: c.id, nombre: nombre(c), handle: handle(c), parent: c.parent || 0,
    padre: c.parent ? nombre(cats.find(x => x.id === c.parent) || {}) : '',
    directos: directos[c.id] || 0, hijos: (hijosDe[c.id] || []).length,
  });

  // Vacias totales
  const vacias = cats.filter(c => totalCon(c) === 0).map(info);
  // Se ven vacias en la web (tienen productos pero ninguno visible)
  const vaciasWeb = cats.filter(c => totalCon(c) > 0 && visCon(c) === 0).map(c => ({ ...info(c), ocultos: totalCon(c) }));

  // Slugs con sufijo numerico que son INTENCIONALES (no duplicados) — no sugerir fusion:
  // guantes2 = Invierno>Guantes (distinto de Deportes>Guantes); camping2 = Mochilas>Camping;
  // mochilas3 = Camping>Mochilas; valijas1 = Set de Valijas; navidad1 = LIQUIDACION (raiz promo);
  // mochilas2/carteras2/billeteras3 = subs de Liquidacion; mochilas1/billeteras1 = subs de Ahorraton.
  const IGNORAR = new Set(['guantes2', 'camping2', 'mochilas3', 'valijas1', 'navidad1',
    'mochilas2', 'carteras2', 'billeteras3', 'mochilas1', 'billeteras1']);

  // Duplicados: mismo nombre normalizado con mismo padre, o handle con sufijo numerico cuya base existe
  const sugerencias = [];
  const visto = new Set();
  for (const c of cats) {
    const h = handle(c);
    if (IGNORAR.has(h)) continue;
    const m = h.match(/^(.*?)(\d+)$/);
    if (m) {
      const base = cats.find(x => handle(x) === m[1] && x.id !== c.id);
      if (base && !visto.has(c.id)) {
        visto.add(c.id);
        sugerencias.push({ tipo: 'slug numerado', dup: info(c), target: info(base) });
        continue;
      }
    }
    const gemelo = cats.find(x => x.id !== c.id && (x.parent || 0) === (c.parent || 0) && norm(nombre(x)) === norm(nombre(c)));
    if (gemelo && !visto.has(c.id) && !visto.has(gemelo.id)) {
      visto.add(c.id);
      const [a, b] = (directos[gemelo.id] || 0) >= (directos[c.id] || 0) ? [c, gemelo] : [gemelo, c];
      sugerencias.push({ tipo: 'mismo nombre', dup: info(a), target: info(b) });
    }
  }

  // Categorias de precio de Mochilas: se actualizan solas en cada analisis (es una escritura, por eso backup primero)
  await asegurarBackupDelDia();
  const preciosMochilas = await actualizarPreciosMochilas();

  return {
    fecha: new Date().toISOString(),
    totalCategorias: cats.length,
    totalProductos: productos.length,
    sinCategoria,
    vacias, vaciasWeb, sugerencias,
    preciosMochilas,
  };
}

// ---------- Acciones ----------
async function backup() {
  const dir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const fecha = new Date().toISOString().slice(0, 10);
  const categorias = await getAll('/categories');
  const productos = await getAll('/products');
  fs.writeFileSync(path.join(dir, `categorias-${fecha}.json`), JSON.stringify(categorias, null, 2));
  fs.writeFileSync(path.join(dir, `productos-${fecha}.json`), JSON.stringify(productos, null, 2));
  fs.writeFileSync(path.join(dir, `producto-categorias-${fecha}.json`),
    JSON.stringify(productos.map(p => ({ id: p.id, nombre: nombre(p), categorias: (p.categories || []).map(c => c.id) })), null, 2));
  return { categorias: categorias.length, productos: productos.length, carpeta: dir };
}

// Garantiza un backup del dia antes de cualquier accion destructiva (no depende del vendedor)
async function asegurarBackupDelDia() {
  const fecha = new Date().toISOString().slice(0, 10);
  const f = path.join(__dirname, '..', 'backups', `productos-${fecha}.json`);
  if (fs.existsSync(f)) return { yaExistia: true };
  const r = await backup();
  return { yaExistia: false, ...r };
}

async function fusionar(dupId, targetId) {
  const bk = await asegurarBackupDelDia();
  if (!bk.yaExistia) console.log('Backup automatico del dia creado antes de fusionar');
  const { data: dupCat } = await api(`/categories/${dupId}`);
  if (!dupCat || !dupCat.id) throw new Error('La categoria duplicada no existe');
  const cats = await getAll('/categories');
  if (cats.some(c => c.parent === dupId)) throw new Error('La duplicada tiene subcategorias: fusionalas primero');
  const prods = await getAll(`/products?category_id=${dupId}&fields=id,categories`);
  let movidos = 0;
  for (const p of prods) {
    const ids = [...new Set(p.categories.map(c => c.id === dupId ? targetId : c.id))];
    await api(`/products/${p.id}`, { method: 'PUT', body: JSON.stringify({ categories: ids }) });
    movidos++;
    await sleep(350);
  }
  const resto = await getAll(`/products?category_id=${dupId}&fields=id`);
  if (resto.length > 0) throw new Error(`Quedaron ${resto.length} productos, no se borra`);
  await api(`/categories/${dupId}`, { method: 'DELETE' });
  const fin = await getAll(`/products?category_id=${targetId}&fields=id`);
  return { movidos, targetAhora: fin.length };
}

async function borrarVacia(id) {
  await asegurarBackupDelDia();
  const prods = await getAll(`/products?category_id=${id}&fields=id`);
  if (prods.length > 0) throw new Error(`Tiene ${prods.length} productos, no se borra`);
  const cats = await getAll('/categories');
  if (cats.some(c => c.parent === id)) throw new Error('Tiene subcategorias, no se borra');
  await api(`/categories/${id}`, { method: 'DELETE' });
  return { ok: true };
}

// ---------- HTML: login ----------
const LOGIN_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ingresar — Mantenimiento HappyBuy</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;background:#f4f5f7;color:#1c2430;display:flex;align-items:center;justify-content:center;height:100vh}
  .card{background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.08);padding:28px;width:300px}
  h1{font-size:18px;margin:0 0 18px}
  input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:14px;margin-bottom:10px}
  button{width:100%;background:#2563eb;color:#fff;border:0;border-radius:7px;padding:9px 14px;font-size:14px;cursor:pointer}
  #err{color:#dc2626;font-size:13px;min-height:18px;margin-bottom:6px}
</style></head><body>
<div class="card">
  <h1>🛠️ Mantenimiento HappyBuy</h1>
  <div id="err"></div>
  <input id="u" placeholder="Usuario" autofocus>
  <input id="p" placeholder="Contraseña" type="password">
  <button onclick="entrar()">Ingresar</button>
</div>
<script>
async function entrar() {
  const usuario = document.getElementById('u').value.trim();
  const password = document.getElementById('p').value;
  const r = await fetch('/api/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ usuario, password }) });
  if (r.ok) { window.location.href = '/'; return; }
  const j = await r.json().catch(() => ({}));
  document.getElementById('err').textContent = j.error || 'Error al ingresar';
}
document.getElementById('p').addEventListener('keydown', e => { if (e.key === 'Enter') entrar(); });
</script></body></html>`;

// ---------- HTML ----------
const HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mantenimiento HappyBuy</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;background:#f4f5f7;color:#1c2430}
  header{background:#111827;color:#fff;padding:14px 22px;display:flex;justify-content:space-between;align-items:center}
  h1{font-size:18px;margin:0} main{max-width:960px;margin:20px auto;padding:0 16px}
  .card{background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.08);padding:16px 18px;margin-bottom:16px}
  button{background:#2563eb;color:#fff;border:0;border-radius:7px;padding:8px 14px;font-size:14px;cursor:pointer}
  button.sec{background:#6b7280} button.danger{background:#dc2626} button:disabled{opacity:.5;cursor:wait}
  table{width:100%;border-collapse:collapse;font-size:14px} td,th{padding:6px 8px;border-bottom:1px solid #eee;text-align:left}
  .pill{display:inline-block;background:#eef2ff;color:#3730a3;border-radius:99px;padding:1px 9px;font-size:12px}
  #log{font-family:monospace;font-size:12px;white-space:pre-wrap;background:#0f172a;color:#a5f3a5;border-radius:8px;padding:10px;min-height:40px;max-height:220px;overflow:auto}
  .stats{display:flex;gap:18px;flex-wrap:wrap} .stat b{font-size:22px;display:block}
  header .userbox{display:flex;align-items:center;gap:10px;font-size:13px}
  header a{color:#cbd5e1;text-decoration:none} header a:hover{color:#fff}
  input.mini{padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px}
  select.mini{padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px}
</style></head><body>
<header><h1>🛠️ Mantenimiento de categorías — HappyBuy</h1>
<div class="userbox">
  <span id="quienSoy"></span>
  <a href="#" id="linkUsuarios" style="display:none">👤 Usuarios</a>
  <a href="#" onclick="cerrarSesion()">Salir</a>
  <button class="sec" onclick="hacerBackup()">💾 Backup</button> <button onclick="analizar()">🔍 Analizar</button>
</div></header>
<main>
  <div class="card" id="cardUsuarios" style="display:none">
    <h3>Usuarios <span class="pill" id="nUsuarios">0</span></h3>
    <table id="tUsuarios"></table>
    <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
      <input class="mini" id="nuUsuario" placeholder="Usuario nuevo">
      <input class="mini" id="nuPassword" placeholder="Contraseña" type="password">
      <select class="mini" id="nuRol"><option value="vendedor">Vendedor</option><option value="admin">Admin</option></select>
      <button onclick="crearUsuario()">Agregar</button>
    </div>
  </div>
  <div class="card"><div class="stats" id="stats">Apretá <b>Analizar</b> para empezar. Recomendado: hacer un <b>Backup</b> antes de aplicar cambios.</div></div>
  <div class="card"><h3>Categorías de precio (Mochilas) <span class="pill" id="nPrecios">0</span></h3>
    <p style="color:#6b7280;font-size:13px">Se recalculan solas cada vez que apretás Analizar (precio con transferencia −15%, cartucheras excluidas).</p>
    <table id="tPrecios"></table></div>
  <div class="card"><h3>Posibles duplicadas <span class="pill" id="nDup">0</span></h3>
    <p style="color:#6b7280;font-size:13px">Detectadas por slug con sufijo numérico (ej. mochilas4) o mismo nombre con el mismo padre. Revisá antes de fusionar: los productos pasan a la categoría destino y la duplicada se borra.</p>
    <table id="tDup"></table></div>
  <div class="card"><h3>Vacías (0 productos) <span class="pill" id="nVac">0</span></h3><table id="tVac"></table></div>
  <div class="card"><h3>Se ven vacías en la web (todo sin stock) <span class="pill" id="nVacWeb">0</span></h3>
    <p style="color:#6b7280;font-size:13px">Tienen productos pero ninguno visible. No se borran solas: reponé stock o borralas a mano desde el admin si corresponde.</p>
    <table id="tVacWeb"></table></div>
  <div class="card"><h3>Registro</h3><div id="log"></div></div>
</main>
<script>
const log = m => { const el = document.getElementById('log'); el.textContent += m + "\\n"; el.scrollTop = el.scrollHeight; };
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}
async function hacerBackup() {
  log('Backup en curso...');
  try { const r = await post('/api/backup'); log('Backup OK: ' + r.categorias + ' categorias, ' + r.productos + ' productos -> ' + r.carpeta); }
  catch (e) { log('ERROR backup: ' + e.message); }
}
let ultimo = null;
async function analizar() {
  log('Analizando catalogo (puede tardar ~1 min)...');
  try {
    const r = await fetch('/api/analisis'); ultimo = await r.json();
    document.getElementById('stats').innerHTML =
      '<div class="stat"><b>' + ultimo.totalCategorias + '</b>categorías</div>' +
      '<div class="stat"><b>' + ultimo.totalProductos + '</b>productos</div>' +
      '<div class="stat"><b>' + ultimo.sinCategoria + '</b>sin categoría</div>' +
      '<div class="stat"><b>' + ultimo.sugerencias.length + '</b>posibles duplicadas</div>' +
      '<div class="stat"><b>' + ultimo.preciosMochilas.reduce((s,p)=>s+p.agregadas+p.sacadas,0) + '</b>cambios de precio</div>';
    render(); log('Analisis OK (' + ultimo.fecha + ')');
  } catch (e) { log('ERROR analisis: ' + e.message); }
}
function fila(cols) { return '<tr>' + cols.map(c => '<td>' + c + '</td>').join('') + '</tr>'; }
function render() {
  document.getElementById('nPrecios').textContent = ultimo.preciosMochilas.length;
  document.getElementById('tPrecios').innerHTML = '<tr><th>Categoría</th><th>Agregadas</th><th>Sacadas</th><th>Total</th></tr>' +
    ultimo.preciosMochilas.map(p => fila([p.nombre, '+' + p.agregadas, '-' + p.sacadas, p.total])).join('');
  document.getElementById('nDup').textContent = ultimo.sugerencias.length;
  document.getElementById('tDup').innerHTML = '<tr><th>Duplicada</th><th>Destino sugerido</th><th>Motivo</th><th></th></tr>' +
    ultimo.sugerencias.map((s, i) => fila([
      s.dup.nombre + ' <span class="pill">' + s.dup.directos + ' prod</span><br><small>/' + s.dup.handle + '/ ' + (s.dup.padre ? 'en ' + s.dup.padre : '(raíz)') + '</small>',
      s.target.nombre + ' <span class="pill">' + s.target.directos + ' prod</span><br><small>/' + s.target.handle + '/</small>',
      s.tipo,
      '<button onclick="fusionar(' + i + ', this)">Fusionar →</button>'])).join('');
  document.getElementById('nVac').textContent = ultimo.vacias.length;
  document.getElementById('tVac').innerHTML = '<tr><th>Categoría</th><th></th></tr>' +
    ultimo.vacias.map(v => fila([v.nombre + ' <small>/' + v.handle + '/ ' + (v.padre ? 'en ' + v.padre : '(raíz)') + '</small>',
      '<button class="danger" onclick="borrar(' + v.id + ', this)">Borrar</button>'])).join('');
  document.getElementById('nVacWeb').textContent = ultimo.vaciasWeb.length;
  document.getElementById('tVacWeb').innerHTML = '<tr><th>Categoría</th><th>Ocultos</th></tr>' +
    ultimo.vaciasWeb.map(v => fila([v.nombre + ' <small>/' + v.handle + '/ ' + (v.padre ? 'en ' + v.padre : '(raíz)') + '</small>', v.ocultos])).join('');
}
async function fusionar(i, btn) {
  const s = ultimo.sugerencias[i];
  if (!confirm('Fusionar "' + s.dup.nombre + '" (' + s.dup.directos + ' prod) dentro de "' + s.target.nombre + '"?')) return;
  btn.disabled = true; log('Fusionando ' + s.dup.nombre + ' -> ' + s.target.nombre + '...');
  try { const r = await post('/api/fusionar', { dup: s.dup.id, target: s.target.id }); log('OK: ' + r.movidos + ' movidos, destino ahora ' + r.targetAhora); analizar(); }
  catch (e) { log('ERROR: ' + e.message); btn.disabled = false; }
}
async function borrar(id, btn) {
  if (!confirm('Borrar esta categoria vacia?')) return;
  btn.disabled = true; log('Borrando ' + id + '...');
  try { await post('/api/borrar-vacia', { id }); log('Borrada ' + id); analizar(); }
  catch (e) { log('ERROR: ' + e.message); btn.disabled = false; }
}
async function cerrarSesion() { await fetch('/api/logout', { method: 'POST' }); window.location.href = '/login'; }
async function cargarQuienSoy() {
  const r = await fetch('/api/me'); const yo = await r.json();
  document.getElementById('quienSoy').textContent = yo.usuario + ' (' + yo.role + ')';
  if (yo.role === 'admin') {
    document.getElementById('linkUsuarios').style.display = '';
    document.getElementById('linkUsuarios').onclick = (e) => { e.preventDefault(); toggleUsuarios(); };
  }
}
function toggleUsuarios() {
  const c = document.getElementById('cardUsuarios');
  c.style.display = c.style.display === 'none' ? '' : 'none';
  if (c.style.display !== 'none') cargarUsuarios();
}
async function cargarUsuarios() {
  const r = await fetch('/api/usuarios'); const lista = await r.json();
  document.getElementById('nUsuarios').textContent = lista.length;
  document.getElementById('tUsuarios').innerHTML = '<tr><th>Usuario</th><th>Rol</th><th></th></tr>' +
    lista.map(u => fila([u.usuario, u.role, u.usuario === 'kevin' ? '' : '<button class="danger" onclick="borrarUsuario(\\'' + u.usuario + '\\')">Borrar</button>'])).join('');
}
async function crearUsuario() {
  const usuario = document.getElementById('nuUsuario').value.trim();
  const password = document.getElementById('nuPassword').value;
  const role = document.getElementById('nuRol').value;
  if (!usuario || !password) return alert('Completá usuario y contraseña');
  try { await post('/api/usuarios', { usuario, password, role }); document.getElementById('nuUsuario').value=''; document.getElementById('nuPassword').value=''; log('Usuario creado: ' + usuario); cargarUsuarios(); }
  catch (e) { log('ERROR creando usuario: ' + e.message); }
}
async function borrarUsuario(usuario) {
  if (!confirm('Borrar usuario ' + usuario + '?')) return;
  await fetch('/api/usuarios/' + encodeURIComponent(usuario), { method: 'DELETE' });
  cargarUsuarios();
}
cargarQuienSoy();
</script></body></html>`;

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    // Login: publico, sin sesion requerida
    if (req.method === 'GET' && req.url === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LOGIN_HTML);
    }
    if (req.method === 'POST' && req.url === '/api/login') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { usuario, password } = body ? JSON.parse(body) : {};
      const usuarios = leerUsuarios();
      const u = usuarios[usuario];
      if (!u || !verificarPassword(password || '', u.salt, u.hash)) return json(401, { error: 'Usuario o contraseña incorrectos' });
      const token = crypto.randomBytes(24).toString('hex');
      sesiones.set(token, { username: usuario, role: u.role });
      res.setHeader('Set-Cookie', `sesion=${token}; HttpOnly; Path=/; SameSite=Lax`);
      return json(200, { ok: true });
    }

    // A partir de aca, todo requiere sesion valida
    const sesion = sesionActual(req);
    if (!sesion) {
      if (req.method === 'GET') { res.writeHead(302, { Location: '/login' }); return res.end(); }
      return json(401, { error: 'No autenticado' });
    }

    if (req.method === 'POST' && req.url === '/api/logout') {
      const token = getCookie(req, 'sesion');
      if (token) sesiones.delete(token);
      return json(200, { ok: true });
    }
    if (req.method === 'GET' && req.url === '/api/me') {
      return json(200, { usuario: sesion.username, role: sesion.role });
    }

    // Gestion de usuarios: solo admin
    if (req.url === '/api/usuarios' || req.url.startsWith('/api/usuarios/')) {
      if (sesion.role !== 'admin') return json(403, { error: 'Solo un admin puede gestionar usuarios' });
      const usuarios = leerUsuarios();
      if (req.method === 'GET' && req.url === '/api/usuarios') {
        return json(200, Object.entries(usuarios).map(([usuario, u]) => ({ usuario, role: u.role })));
      }
      if (req.method === 'POST' && req.url === '/api/usuarios') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { usuario, password, role } = JSON.parse(body);
        if (!usuario || !password) return json(400, { error: 'Falta usuario o contraseña' });
        const { salt, hash } = hashPassword(password);
        usuarios[usuario] = { salt, hash, role: role === 'admin' ? 'admin' : 'vendedor' };
        guardarUsuarios(usuarios);
        return json(200, { ok: true });
      }
      if (req.method === 'DELETE' && req.url.startsWith('/api/usuarios/')) {
        const usuario = decodeURIComponent(req.url.split('/api/usuarios/')[1] || '');
        if (usuario === 'kevin') return json(400, { error: 'No se puede borrar la cuenta principal' });
        delete usuarios[usuario];
        guardarUsuarios(usuarios);
        return json(200, { ok: true });
      }
    }

    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }
    if (req.method === 'GET' && req.url === '/api/analisis') return json(200, await analizar());
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data = body ? JSON.parse(body) : {};
      if (req.url === '/api/backup') return json(200, await backup());
      if (req.url === '/api/fusionar') return json(200, await fusionar(Number(data.dup), Number(data.target)));
      if (req.url === '/api/borrar-vacia') return json(200, await borrarVacia(Number(data.id)));
    }
    json(404, { error: 'no encontrado' });
  } catch (e) { json(500, { error: e.message }); }
});

// Modo CLI: `node server.js --analizar` imprime el reporte sin levantar el servidor
if (process.argv.includes('--analizar')) {
  analizar().then(r => {
    console.log(`Categorias: ${r.totalCategorias} | Productos: ${r.totalProductos} | Sin categoria: ${r.sinCategoria}`);
    console.log(`Posibles duplicadas: ${r.sugerencias.length}`);
    for (const s of r.sugerencias) console.log(`  [${s.tipo}] ${s.dup.nombre} (/${s.dup.handle}/, ${s.dup.directos}p) -> ${s.target.nombre} (/${s.target.handle}/)`);
    console.log(`Vacias: ${r.vacias.length}`);
    for (const v of r.vacias) console.log(`  ${v.nombre} (/${v.handle}/)`);
    console.log(`Se ven vacias en la web: ${r.vaciasWeb.length}`);
    for (const v of r.vaciasWeb) console.log(`  ${v.nombre} (/${v.handle}/) — ${v.ocultos} ocultos`);
    console.log('Categorias de precio (Mochilas):');
    for (const p of r.preciosMochilas) console.log(`  ${p.nombre}: +${p.agregadas} -${p.sacadas} = ${p.total} productos`);
  }).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
} else {
  server.listen(PORT, () => console.log(`Mantenimiento HappyBuy: http://localhost:${PORT}`));
}
