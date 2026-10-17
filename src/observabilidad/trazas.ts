import {
  Context,
  context,
  ROOT_CONTEXT,
  Span,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  Tracer,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  SpanProcessor,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import { filtrarAtributos } from './atributos';
import { escribirTraceparent, leerTraceparent } from './traceparent';

/** Lo que cada servicio fija de sus trazas (ver docs/OBSERVABILIDAD.md, sección 1). */
export interface ConfiguracionTrazas {
  /** `service.name`: quinde-gateway, quinde-bff, quinde-core, quinde-identity, quinde-notifier. */
  servicio: string;
  version: string;
  /** `deployment.environment`: development, production... */
  entorno: string;
  /** Base OTLP/HTTP (`http://jaeger:4318`): los spans van a `{base}/v1/traces`. Sin ella, no se exporta. */
  endpointOtlp?: string;
  /** Fracción de trazas raíz que se registran (0 a 1). */
  muestreo: number;
  /** Continuar la traza del `traceparent` entrante (solo detrás de alguien de confianza). */
  confiarEntrante: boolean;
  /** Solo pruebas: cada cuánto sale un lote (ms). */
  esperaLoteMs?: number;
}

/** Cola acotada: si el recolector no da abasto, los spans de más se descartan. */
export const COLA_MAXIMA_SPANS = 2048;
/** Plazo de un envío al recolector: más que esto y el lote se descarta. Nunca afecta a una petición. */
export const PLAZO_EXPORTACION_MS = 3000;
/** Tope del cierre: lo que no salga en este tiempo se pierde, pero el proceso no se cuelga. */
export const PLAZO_CIERRE_MS = 5000;

/**
 * Las trazas de un servicio. El SDK SIEMPRE arranca, aunque no se exporte nada: así hay trace-id
 * para propagar y para los logs. El exportador OTLP/HTTP solo se activa con `endpointOtlp`, por un
 * BatchSpanProcessor (la petición solo encola; el envío va aparte, con cola y plazo acotados).
 *
 * Los spans son manuales: sin instrumentaciones automáticas, cada servicio decide qué registra y
 * con qué atributos (ver atributos.ts).
 */
export class Trazas {
  readonly tracer: Tracer;
  readonly exportando: boolean;
  private readonly proveedor: NodeTracerProvider;

  constructor(readonly config: ConfiguracionTrazas) {
    const procesadores: SpanProcessor[] = [];
    if (config.endpointOtlp) {
      const exportador = new OTLPTraceExporter({
        url: `${config.endpointOtlp.replace(/\/+$/, '')}/v1/traces`,
        timeoutMillis: PLAZO_EXPORTACION_MS,
      });
      procesadores.push(
        new BatchSpanProcessor(exportador, {
          maxQueueSize: COLA_MAXIMA_SPANS,
          maxExportBatchSize: 512,
          scheduledDelayMillis: config.esperaLoteMs ?? 2000,
          exportTimeoutMillis: PLAZO_EXPORTACION_MS,
        }),
      );
    }
    this.exportando = procesadores.length > 0;
    this.proveedor = new NodeTracerProvider({
      resource: resourceFromAttributes({
        'service.name': config.servicio,
        'service.version': config.version,
        'deployment.environment': config.entorno,
      }),
      // La raíz se muestrea con la fracción; un hijo sigue la decisión de su padre
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.muestreo) }),
      spanProcessors: procesadores,
    });
    // register(): contexto asíncrono (AsyncLocalStorage) para que el span activo siga tras cada await
    this.proveedor.register();
    this.tracer = this.proveedor.getTracer(config.servicio, config.version);
  }

  /**
   * El contexto del que cuelga el span raíz de una petición entrante. Por defecto, ninguno: el
   * servicio abre una traza nueva aunque el cliente mande `traceparent`. Con `confiarEntrante` y
   * un `traceparent` válido, continúa esa traza (y respeta su bit de muestreo). Un valor inválido
   * se ignora.
   */
  contextoEntrante(traceparent: string | string[] | undefined): Context {
    if (!this.config.confiarEntrante) return ROOT_CONTEXT;
    const leido = leerTraceparent(traceparent);
    if (!leido) return ROOT_CONTEXT;
    return trace.setSpanContext(ROOT_CONTEXT, {
      traceId: leido.traceId,
      spanId: leido.parentId,
      traceFlags: leido.muestreado ? TraceFlags.SAMPLED : TraceFlags.NONE,
      isRemote: true,
    });
  }

  /** Abre un span con atributos filtrados por la lista permitida. */
  iniciar(
    nombre: string,
    tipo: SpanKind,
    atributos: Record<string, string | number | boolean | undefined>,
    padre: Context = context.active(),
  ): Span {
    return this.tracer.startSpan(
      nombre,
      { kind: tipo, attributes: filtrarAtributos(atributos) },
      padre,
    );
  }

  /** Corre `trabajo` con `span` como activo (logs y spans hijos lo toman de ahí). */
  conSpan<T>(span: Span, trabajo: () => T): T {
    return context.with(trace.setSpan(context.active(), span), trabajo);
  }

  /** Corre `trabajo` dentro de un contexto ya armado (el de la petición). */
  enContexto<T>(contexto: Context, trabajo: () => T): T {
    return context.with(contexto, trabajo);
  }

  /** Cierra el proveedor sin colgar el proceso: lo que no salga en PLAZO_CIERRE_MS se pierde. */
  async cerrar(): Promise<void> {
    let temporizador: NodeJS.Timeout | undefined;
    const tope = new Promise<void>((listo) => {
      temporizador = setTimeout(listo, PLAZO_CIERRE_MS);
      temporizador.unref();
    });
    await Promise.race([this.proveedor.shutdown().catch(() => undefined), tope]);
    clearTimeout(temporizador);
  }
}

/** `traceparent` para mandar a un upstream con `span` como padre. */
export function traceparentDe(span: Span): string {
  const { traceId, spanId, traceFlags } = span.spanContext();
  return escribirTraceparent(
    traceId,
    spanId,
    (traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED,
  );
}

/**
 * Marca el span como error con un tipo de una lista cerrada (`error.type`), nunca con el mensaje
 * del error: el de un error de red o del upstream puede traer URLs internas.
 */
export function marcarError(span: Span, tipo: string): void {
  span.setAttributes(filtrarAtributos({ 'error.type': tipo }));
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/**
 * `traceId` y `spanId` del span activo, para el `mixin` del logger: toda línea de log escrita
 * dentro de una petición los lleva. Fuera de una petición (arranque), nada.
 */
export function camposDeTraza(): { traceId?: string; spanId?: string } {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const { traceId, spanId } = span.spanContext();
  return { traceId, spanId };
}
