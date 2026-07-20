// Sincroniza subcategorias de MOCHILAS por rango de precio (con transferencia).
// Agrega las mochilas que caen en el rango y saca las que ya no califican.
// Pensado para correr periodicamente (Programador de tareas de Windows o cron).
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
  'User-Agent': 'HappyBuy Optimizacion (olkekevin@gmail.com)',
  'Content-Type': 'application/json',
};

const MOCHILAS = 34015480;          // raiz MOCHILAS
const CARTUCHERAS = 34634705;       // siempre excluidas de las categorias por precio
const DESC_TRANSFERENCIA = 0.15;    // precio con transferencia = precio de pagina -15%

// Agregar/editar rangos aca. min es inclusivo, max es exclusivo (null = sin tope).
const RANGOS = [
  { nombre: 'Menos de $10.000', handle: 'mochilas-menos-de-10000', min: 0, max: 10000 },
  { nombre: '$10.000 a $15.000', handle: 'mochilas-10000-a-15000', min: 10000, max: 15000 },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(path_, opts = {}) {
  for (let i = 1; ; i++) {
    const r = await fetch(`${BASE}${path_}`, { headers: HEADERS, ...opts });
    if (r.status === 429 && i < 6) { await sleep(2000 * i); continue; }
    const text = await r.text();
    if (!r.ok && r.status !== 404) throw new Error(`${opts.method || 'GET'} ${path_}: HTTP ${r.status} ${text.slice(0, 300)}`);
    return { status: r.status, data: text ? JSON.parse(text) : null };
  }
}

async function getAll(path_) {
  const out = [];
  for (let page = 1; ; page++) {
    const { status, data } = await api(`${path_}${path_.includes('?') ? '&' : '?'}per_page=200&page=${page}`);
    if (status === 404 || !Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < 200) break;
  }
  return out;
}

(async () => {
  // 1. Buscar (o crear) cada subcategoria de rango
  const cats = await getAll('/categories');
  for (const rango of RANGOS) {
    let cat = cats.find(c => (c.handle?.es || '') === rango.handle);
    if (!cat) {
      const { data } = await api('/categories', {
        method: 'POST',
        body: JSON.stringify({ name: { es: rango.nombre }, handle: { es: rango.handle }, parent: MOCHILAS }),
      });
      cat = data;
      cats.push(cat);
      console.log(`Creada subcategoria [${cat.id}] "${rango.nombre}" (/${cat.handle.es}/)`);
    }
    rango.catId = cat.id;
  }

  // 2. Recorrer todas las mochilas una sola vez y decidir pertenencia por cada rango
  const prods = await getAll(`/products?category_id=${MOCHILAS}&fields=id,name,categories,variants`);
  console.log(`Mochilas analizadas: ${prods.length}`);

  const resumen = Object.fromEntries(RANGOS.map(r => [r.handle, { agregadas: 0, sacadas: 0 }]));
  for (const p of prods) {
    // Precio de pagina = el que ve el cliente: promocional si existe, si no el de lista.
    // Solo variantes CON STOCK: una promo en una variante sin stock no es comprable y no debe definir el precio.
    const variantesComprables = (p.variants || []).filter(v => (v.stock === null || v.stock > 0));
    const fuente = variantesComprables.length > 0 ? variantesComprables : (p.variants || []);
    const precios = fuente.map(v => parseFloat(v.promotional_price || v.price)).filter(n => !isNaN(n));
    if (precios.length === 0) continue;
    const minPrecio = Math.min(...precios);
    const precioTransferencia = minPrecio * (1 - DESC_TRANSFERENCIA);
    const esCartuchera = p.categories.some(c => c.id === CARTUCHERAS);

    let ids = p.categories.map(c => c.id);
    let cambio = false;
    for (const rango of RANGOS) {
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

  for (const rango of RANGOS) {
    const { data: fin } = await api(`/products?category_id=${rango.catId}&per_page=200&fields=id`);
    const r = resumen[rango.handle];
    console.log(`"${rango.nombre}": +${r.agregadas} -${r.sacadas} = ${fin.length} productos`);
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
