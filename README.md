# Bybit Perp Screener

Screener en tiempo real de **todos los perpetuos listados en Bybit**, con
**volume delta** (presión compradora menos vendedora) calculado en varias
ventanas: 1m, 5m, 10m, 15m, 30m, 1h, 4h y 24h.

Tabla densa, ordenable por cualquier columna, con buscador, favoritos y filtros
por volumen, dirección y tamaño del delta.

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

## Arranque rápido

Requisitos: **Node 22.4 o superior** (por el `WebSocket` nativo). Nada más.

```bash
git clone <este-repo>
cd Crypto-screener
npm start
```

Abre <http://127.0.0.1:8787>.

Al arrancar descarga la lista de perpetuos, abre las conexiones WebSocket
necesarias (unos 100 símbolos por conexión) y empieza a acumular. Para ver la
interfaz funcionando sin esperar (y sin tocar Bybit) hay un mercado simulado:

```bash
npm run mock       # datos inventados, útil para probar la interfaz
```

Dejarlo encendido de fondo en un servidor o un Raspberry Pi es la forma normal
de usarlo: cuanto más tiempo lleve corriendo, más ventanas completas.

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
| `MOCK` | `0` | Feed simulado, sin conexión a Bybit |
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

```
server/
  index.js         HTTP + SSE + estáticos (node:http, sin framework)
  screener.js      Orquestador: instrumentos, tickers y construcción de snapshots
  volume-store.js  Acumulador de delta en ring buffers de dos niveles
  snapshot.js      Persistencia binaria del historial
  trade-stream.js  Pool de WebSockets a publicTrade.* con reconexión y ping
  bybit-rest.js    Cliente REST v5 (instrumentos y tickers)
  bybit-source.js  Fuente real
  mock-feed.js     Mercado simulado con la misma interfaz
  config.js        Configuración y logger
public/            Interfaz (módulos ES nativos, sin build ni framework)
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

40 tests: matemática de las ventanas y rotación de cubos, ida y vuelta de la
persistencia, formateo de cifras, protocolo WebSocket contra un socket falso con
mensajes reales de Bybit (suscripción por tandas, ping, reconexión,
contratos inversos) y la API HTTP completa arrancando el servidor de verdad.

## Notas y limitaciones

- **El delta es de *taker*.** Mide agresión, no posicionamiento neto: por cada
  comprador agresivo hay un vendedor pasivo al otro lado.
- **Las ventanas largas necesitan tiempo encendido.** Ver arriba; las celdas
  atenuadas avisan de ello.
- **Precisión de la ventana**: resolución de 10 s hasta 1 h y de 1 min por
  encima. Una ventana de 10m cubre entre 10m00s y 10m10s de trades.
- Solo usa endpoints **públicos**: no hace falta API key ni hay órdenes de por
  medio.
- Los datos del feed simulado (`MOCK=1`) son inventados; la interfaz lo avisa
  bajo el título.
