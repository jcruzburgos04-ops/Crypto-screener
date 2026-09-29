# Estudio de subidas de +50%

Responde con datos de Bybit: **¿qué mostraban los perpetuos antes de subir +50%
en un día, y cuántas veces esa misma señal apareció sin que hubiera subida?**

La segunda mitad de la pregunta es la que importa para operar. Casi todo lo que
se publica describe la señal (OI disparado, funding muy negativo, shorts
liquidados) *en las monedas que subieron*; ninguna nota cuenta cuántas veces
apareció lo mismo y no pasó nada.

## Correrlo

Necesita salida a `api.bybit.com` (endpoints públicos, sin API key) y Node 22.

```bash
npm run study -- --days 180            # todos los perpetuos USDT/USDC, 180 días
npm run study -- --days 90 --symbols PEPEUSDT,WIFUSDT,POPCATUSDT
```

Deja en `research/out/`:

- `report.md` — el informe: qué rasgos separan las subidas del resto (AUC), qué
  tan seguido acierta cada señal (precisión, lift, primera mitad contra
  segunda) y la lista de subidas con sus rasgos 24 h, 6 h y justo antes.
- `episodes.csv` — cada subida con todos sus rasgos, para abrir en una planilla.
- `summary.json` — lo mismo en crudo.

Las respuestas de Bybit quedan en `research/cache/`: volver a correrlo el mismo
día no repite los pedidos. La primera corrida con todos los pares hace unos 40
pedidos por par (~25.000 en total) y tarda del orden de 10–30 minutos.

| Opción | Por defecto | |
| --- | --- | --- |
| `--days` | 180 | días estudiados (se bajan 32 más de calentamiento) |
| `--threshold` | 0.5 | subida buscada (0.5 = +50%) |
| `--horizon` | 24 | horas para alcanzarla |
| `--symbols` | todos | lista separada por comas |
| `--max-symbols` | 0 | limitar la cantidad de pares (0 = todos) |
| `--concurrency` | 6 | pares descargados en paralelo |
| `--no-cache` | | no leer ni escribir la caché |

## Cómo mide, y por qué así

- **Qué es una subida.** Desde el cierre de una hora, el máximo de las 24 h
  siguientes llega a +50%. Es la pregunta de quien entra en ese momento. Las
  horas seguidas que cumplen eso forman un *episodio*; su primera hora es el
  último momento "temprano" para entrar.
- **Nada mira el futuro.** Cada rasgo de la hora *i* usa solo velas hasta *i*.
  El open interest y el ratio long/short entran con una hora de retraso, porque
  Bybit no documenta si su marca de tiempo es el inicio o el fin del intervalo.
  Hay una prueba que altera todo lo posterior a *i* y exige que nada cambie.
- **Precisión, no solo recall.** Cada señal se cuenta sobre todas las horas: de
  cuántas veces se encendió, cuántas terminaron en subida. El *lift* compara eso
  con la tasa base (la probabilidad de subida de una hora cualquiera).
- **Como operaría una persona.** Una entrada por par cada 24 h como máximo, con
  su retorno y su caída máxima en las 24 h siguientes.
- **Estabilidad.** Las métricas se dan para la primera y la segunda mitad del
  período. Una señal que brilla en una mitad y no en la otra es azar.

## Qué no puede ver

- **Liquidaciones:** Bybit no publica su historia (solo el stream
  `allLiquidation` en tiempo real). **Delta de volumen:** las velas no traen el
  desglose comprador/vendedor. Las dos cosas se pueden empezar a registrar desde
  ahora con el screener, pero no hacia atrás.
- **Pares deslistados:** solo entran los que siguen listados, y muchas subidas
  terminan en derrumbe y deslistado. Eso infla el resultado a favor de las señales.
- **Costos:** los retornos no descuentan comisiones, funding, deslizamiento ni la
  liquidación de la propia posición, que en estas monedas es lo habitual.
