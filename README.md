# Optimización web — HappyBuy

Herramientas para mantener ordenado el catálogo de categorías de [happybuyargentina.com](https://happybuyargentina.com) (Tiendanube).

## Qué incluye

- **`mantenimiento/`** — panel web con login (usuario admin y vendedores) para:
  - Detectar categorías duplicadas o vacías y fusionarlas/borrarlas con un clic
  - Actualizar automáticamente las categorías de Mochilas por rango de precio
  - Hacer backup del catálogo antes de cualquier cambio
- **`sync-mochilas-precio.js`** — script standalone para actualizar las categorías de precio (mismo motor que usa el panel).
- **`backup-catalogo.js`** — backup completo de productos y categorías a JSON.
- **`precio-efectivo/`** — prototipo de servidor de precios en efectivo (no usado en producción).

## Uso local

1. Instalar Node.js 18 o superior.
2. Copiar `.env.example` a `.env` y completar `TN_ACCESS_TOKEN` y `TN_STORE_ID` (se generan en el admin de Tiendanube: Configuración → Aplicaciones a medida).
3. Para el panel de mantenimiento:
   ```
   cd mantenimiento
   node server.js
   ```
   Abrir `http://localhost:3010`. La primera vez se crea el usuario admin `kevin` con la contraseña definida en el código (cambiarla luego desde el panel de Usuarios).

## Despliegue online (Render, Railway, etc.)

1. Conectar el repositorio al servicio de hosting.
2. Comando de arranque: `node mantenimiento/server.js`
3. Configurar como variables de entorno del servicio (no como archivo): `TN_ACCESS_TOKEN`, `TN_STORE_ID`.
4. Para que `usuarios.json` y los backups no se borren en cada despliegue, usar un disco persistente (la mayoría de los planes gratuitos no lo incluyen).

## Seguridad

- `TN_ACCESS_TOKEN` da acceso completo a la tienda (productos, categorías, precios). Nunca commitear el `.env` ni compartir el token.
- Las contraseñas de usuarios se guardan hasheadas (`usuarios.json`, excluido del repo).
- El acceso al panel requiere login; solo el rol `admin` puede gestionar usuarios.
