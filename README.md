# Bybit Perp Screener

Screener en tiempo real de **todos los perpetuos listados en Bybit**, con
**volume delta** (presión compradora menos vendedora) calculado en varias
ventanas: 1m, 5m, 10m, 15m, 30m, 1h, 4h y 24h.

Tabla densa, ordenable por cualquier columna, con buscador, favoritos y filtros
por volumen, dirección y tamaño del delta.

**Abrir online:** <https://jcruzburgos04-ops.github.io/Crypto-screener/>
*(hay que activar GitHub Pages una vez: ver [Publicar la página](#publicar-la-página).)*

```
Par        Precio      24h %     Vol 24h    5m Vol Delta   10m Vol Delta ↓   1h Vol Delta
ETH        $2,452.83   -2.83%    $16.8b     $1.2m          $3.1m             $2.05m
ZEC        $1,010.49    0.08%    $3.65b     $412.8k        $937.39k          $1.53m
ASTER      $0.7858      4.75%    $204.38m   $180.1k        $515.38k          $2.96m
```

Sin dependencias de npm: usa `fetch` y `WebSocket` nativos de Node 22.

---

## Cómo se calcula el volume delta

**Volume delta = volumen agresor comprador − volumen agresor vendedor**, medido
en USD dentro de la ventana elegida.

Bybit **no** publica ese desglose en las velas (las klines solo traen volumen
total), así que el dato no se puede pedir por REST: hay que construirlo. El
screener se suscribe al canal público `publicTrade.{símbolo}` por WebSocket,
donde cada operación llega con el campo `S` = lado del **taker**, y va sumando:

- `S = "Buy"`  → alguien compró a mercado → suma al lado comprador
- `S = "Sell"` → alguien vendió a mercado → suma al lado vendedor

El importe de cada trade se convierte a USD (`precio × cantidad` en contratos
lineales; en inversos el tamaño ya viene en USD) y se acumula en cubos
temporales. Las ventanas se leen sumando los cubos hacia atrás.

### Relación con el CVD (cumulative volume delta)

El CVD es la **suma acumulada** de ese delta a lo largo del tiempo: una curva que
sube mientras manda la agresión compradora y baja cuando manda la vendedora. Lo
que muestra cada columna de este screener es la **variación del CVD en esa
ventana**:

```
delta 10m = CVD(ahora) − CVD(hace 10 min)
```

Es decir, la misma magnitud que la pendiente del CVD en los últimos 10 minutos,
que es justo lo que sirve para escanear: ordenar por «10m Vol Delta» equivale a
preguntar «¿en qué pares ha subido más el CVD en los últimos 10 minutos?».
Un CVD absoluto acumulado desde el inicio de sesión no serviría para comparar
pares entre sí, porque depende de cuándo empezó a contarse.

### Consecuencia importante: el historial se acumula, no se descarga

Al arrancar por primera vez **no hay datos de delta**: se van llenando a medida
que llegan trades. La columna de 10m es fiable a los 10 minutos, la de 4h a las
4 horas. Mientras una ventana no esté completa, sus celdas aparecen
**atenuadas** y el pie de página indica el historial acumulado.

Para no perderlo en cada reinicio, el estado se guarda en disco
(`data/volume-snapshot.bin`) cada 5 minutos y se restaura al arrancar,
descartando lo que haya caducado. Si el servidor lleva días encendido, todas las
ventanas están completas desde el primer segundo tras un reinicio.

---

## Dos formas de usarlo

La misma interfaz funciona de dos maneras y elige sola cuál le toca.

### 1. Online, por enlace (modo directo)

<https://jcruzburgos04-ops.github.io/Crypto-screener/>

La página es estática: **los WebSockets a Bybit los abre tu propio navegador**,
dentro de un Web Worker. No hay servidor intermedio, no hay nada que instalar y
los datos son los mismos que vería el servidor.

A cambio, **el historial vive mientras la pestaña siga abierta**: si la cierras,
las ventanas empiezan de cero. Para dejarlo un rato en una pantalla o mirar el
delta de 10m está perfecto; para ventanas de 4h o 24h conviene el modo servidor.

Por defecto sigue los **200 pares con más volumen de 24 h** (ajustable en el
selector «Pares»): seguir 600 desde un móvil es mucho pedir.

### 2. En local, con historial persistente (modo servidor)

Requisitos: **Node 22.4 o superior** (por el `WebSocket` nativo). Sin dependencias.

```bash
git clone https://github.com/jcruzburgos04-ops/Crypto-screener.git
cd Crypto-screener
npm start
```

Abre <http://127.0.0.1:8787>. El servidor mantiene las conexiones, acumula el
delta y guarda el historial en disco, así que **las ventanas de 4h y 24h se
llenan aunque cierres el navegador** y sobreviven a un reinicio. Dejarlo
encendido de fondo en un servidor o una Raspberry Pi es la forma normal de
usarlo.

La página detecta el modo sola: si responde `/api/health` usa el servidor (SSE);
si no, se conecta directamente. Se puede forzar con `?mode=direct` o
`?mode=server`.

## Publicar la página

El repositorio incluye el workflow `.github/workflows/pages.yml`, que pasa los
tests y publica `public/` en GitHub Pages en cada empuje. Solo hay que
autorizarlo una vez:

**Settings → Pages → Source: GitHub Actions.**

A partir de ahí, la URL es
`https://<usuario>.github.io/Crypto-screener/`.

## Datos: solo Bybit, en vivo

**La aplicación no tiene ningún modo de datos simulados.** La única fuente
posible es la API pública v5 de Bybit; no hay generador de precios ni archivo de
ejemplo que pueda acabar en pantalla por error. Da igual el modo: en el directo
los trades los recibe tu navegador y en el de servidor los recibe el proceso
local, pero el origen es el mismo canal de Bybit.

| Dato | Origen | Se actualiza |
| --- | --- | --- |
| Volume delta y volumen por ventana | WebSocket `publicTrade.*` | En cuanto llega cada operación |
| Precio, 24h %, volumen 24h, OI, funding | REST `/v5/market/tickers` | Cada 3 s |
| Lista de pares (listados nuevos) | REST `/v5/market/instruments-info` | Cada 30 min |
| Tabla del navegador | SSE desde el servidor | Cada 1,5 s, sin recargar |

La actualización es automática de principio a fin: el navegador no consulta
nada, recibe los snapshots por *Server-Sent Events* y se reconecta solo si se
corta.

### Nunca se enseñan cifras viejas como si fueran de ahora

Si el flujo se interrumpe, la interfaz lo dice en un aviso sobre la tabla en vez
de dejar los números anteriores en pantalla:

- **Sin conexión con el servidor** — el navegador perdió el SSE.
- **Stream de trades caído** — el WebSocket de Bybit está reconectando; el delta
  no avanza.
- **Precios sin actualizar desde hace N s** — el REST de tickers no responde.
- **Esperando los primeros trades** — recién arrancado, aún no hay delta.

Además el pie indica en todo momento «actualizado hace N s», en rojo si pasa de
10 segundos.

*(El único doble de datos del repositorio vive en `test/helpers/fake-source.js`,
lo usan los tests inyectándolo en `main()` y no se puede activar por
configuración.)*

---

## La interfaz

**Columnas fijas:** favorito, par, precio, variación 24h, volumen 24h.
**Columnas de delta:** una por cada timeframe activo (menú *Timeframes*).

**Menú *Columnas*:**

| Opción | Qué añade |
| --- | --- |
| Volumen por timeframe | Volumen total de la ventana junto a su delta |
| Δ como % del volumen | Muestra el delta como porcentaje del volumen de la ventana, para comparar pares de tamaños muy distintos |
| Open interest | Interés abierto en USD |
| Funding | Funding rate actual |
| Favoritos arriba | Fija los pares marcados en la parte superior |

**Filtros:**

- **Buscador**: acepta varios términos (`btc eth sol`), busca por par o moneda base. Atajo: tecla `/`.
- **Chips de moneda**: aparecen si hay más de una moneda de cotización (USDT, USDC…).
- **★ Favoritos**: muestra solo los marcados.
- **Vol 24h ≥**: volumen mínimo. Admite atajos: `500k`, `1.5m`, `2b`.
- **|Δ tf| ≥** y **Δ tf**: filtran por tamaño y dirección del delta. Se aplican
  **al timeframe por el que estás ordenando** — la etiqueta lo indica en todo
  momento (`|Δ 10m| ≥`).

Clic en cualquier cabecera para ordenar; otro clic invierte el sentido. El par
enlaza a su gráfico en Bybit. Los ajustes, favoritos y filtros se guardan en el
navegador.

---

## Configuración

Todo por variables de entorno; los valores por defecto funcionan sin tocar nada.

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Dirección de escucha |
| `CATEGORIES` | `linear` | `linear` (USDT/USDC), `inverse` (margen en moneda), o ambas separadas por coma |
| `QUOTE_COINS` | *(todas)* | Filtra por moneda de cotización, p. ej. `USDT` |
| `MAX_SYMBOLS` | `0` *(sin límite)* | Se queda con los N pares más líquidos |
| `TICKER_INTERVAL_MS` | `3000` | Frecuencia de refresco de precios y volumen 24h |
| `INSTRUMENTS_INTERVAL_MS` | `1800000` | Cada cuánto se buscan listados nuevos |
| `PUSH_INTERVAL_MS` | `1500` | Frecuencia de envío al navegador |
| `SYMBOLS_PER_CONNECTION` | `100` | Símbolos por conexión WebSocket |
| `TOPICS_PER_SUBSCRIBE` | `10` | Topics por mensaje de suscripción |
| `PERSIST` | `1` | Guardar el historial en disco |
| `SNAPSHOT_FILE` | `data/volume-snapshot.bin` | Dónde guardarlo |
| `SNAPSHOT_INTERVAL_MS` | `300000` | Cada cuánto guardarlo |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Ejemplo — solo los 200 pares USDT más líquidos, accesible desde la red local:

```bash
HOST=0.0.0.0 QUOTE_COINS=USDT MAX_SYMBOLS=200 npm start
```

---

## API HTTP

| Endpoint | Descripción |
| --- | --- |
| `GET /api/snapshot?tfs=10m,1h` | Snapshot único en JSON |
| `GET /api/stream?tfs=10m,1h` | Server-Sent Events con un snapshot por tick |
| `GET /api/health` | Estado: trades recibidos, conexiones, cobertura, errores |

Cada fila del snapshot:

```jsonc
{
  "s": "BTCUSDT",     // símbolo            "b": "BTC",   // moneda base
  "q": "USDT",        // moneda cotización  "p": "68123.5", // precio (string, decimales del exchange)
  "c": -0.0283,       // variación 24h como fracción
  "v": 16800000000,   // volumen 24h en USD
  "oi": 1200000000,   // open interest en USD
  "f": 0.0001,        // funding rate
  "d": { "10m": [3100000, 9400000] },  // por timeframe: [delta, volumen total]
  "cov": 3600000,     // historial acumulado para este par (ms)
  "lt": 2             // segundos desde el último trade
}
```

Útil para conectar alertas propias:

```bash
curl -s 'http://127.0.0.1:8787/api/snapshot?tfs=10m' \
  | jq -r '.rows | sort_by(-.d["10m"][0])[:10] | .[] | "\(.s)\t\(.d["10m"][0])"'
```

---

## Arquitectura

El motor es el mismo en los dos modos: corre en Node o dentro de un Web Worker
sin cambiar una línea. Lo único propio de cada entorno es la persistencia (fs),
que se inyecta.

```
public/js/core/    Motor compartido (no depende de Node)
  screener.js        Orquestador: instrumentos, tickers y snapshots
  volume-store.js    Acumulador de delta en ring buffers de dos niveles
  trade-stream.js    Pool de WebSockets a publicTrade.* con reconexión y ping
  bybit-rest.js      Cliente REST v5 (instrumentos y tickers)
  bybit-source.js    Une los dos anteriores
public/js/
  worker.js        Motor dentro del navegador (modo directo)
  app.js           Interfaz: tabla virtualizada, filtros, orden
  format.js        Formateo de cifras
  timeframes.js    Catálogo de ventanas, compartido con el servidor
server/
  index.js         HTTP + SSE + estáticos (node:http, sin framework)
  snapshot.js      Serialización binaria del historial
  persistence.js   Adaptador de disco que se inyecta en el orquestador
  config.js        Configuración y logger
```

**Ring buffers de dos niveles** en `volume-store.js`: cubos de 10 s para las
ventanas de hasta 1 h y cubos de 1 min para las de hasta 24 h. Cada ventana se
lee en una sola pasada por nivel, así que pedir ocho timeframes cuesta casi lo
mismo que pedir uno. Con 600 pares: **~29 KB de memoria por par** y **~1,2 ms**
para construir el snapshot completo (3 timeframes), lo que deja el proceso
holgado en cualquier máquina.

La **tabla es virtualizada**: solo las filas visibles llegan al DOM, así que 600
pares actualizándose cada segundo no ralentizan el navegador.

## Tests

```bash
npm test
```

44 tests: matemática de las ventanas y rotación de cubos, ida y vuelta de la
persistencia, formateo de cifras, protocolo WebSocket contra un socket falso con
mensajes reales de Bybit (suscripción por tandas, ping, reconexión, contratos
inversos) y la API HTTP completa levantando el servidor real, con trades
controlados para comprobar cifras exactas de delta, el reparto por ventanas y el
aviso de datos no vivos.

## Notas y limitaciones

- **El delta es de *taker*.** Mide agresión, no posicionamiento neto: por cada
  comprador agresivo hay un vendedor pasivo al otro lado.
- **Las ventanas largas necesitan tiempo encendido.** Ver arriba; las celdas
  atenuadas avisan de ello. En modo directo el historial se pierde al cerrar la
  pestaña; en modo servidor no.
- **El modo directo depende de que Bybit permita CORS** en sus endpoints
  públicos de mercado. Si tu red, una extensión o el propio exchange lo
  bloquean, la página lo dice con un aviso y siempre queda el modo servidor.
- **Precisión de la ventana**: resolución de 10 s hasta 1 h y de 1 min por
  encima. Una ventana de 10m cubre entre 10m00s y 10m10s de trades.
- Solo usa endpoints **públicos**: no hace falta API key ni hay órdenes de por
  medio.
- El screener es de solo lectura: no envía órdenes ni necesita API key.
