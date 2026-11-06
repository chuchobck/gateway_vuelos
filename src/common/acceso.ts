/**
 * Los campos de la línea de acceso que fija el contrato v2 (§6, regla 4) y docs/OBSERVABILIDAD.md
 * (sección 3), en `snake_case` y con estos nombres en los cinco servicios. Cada listener del
 * gateway (el público y el de eventos) los pone igual.
 */
export function camposDeAcceso(
  servicio: string,
  correlationId: string | undefined,
  requestId: string,
  operacion: string | null,
  status: number,
  latenciaMs: number,
) {
  return {
    timestamp: new Date().toISOString(),
    service: servicio,
    correlation_id: correlationId ?? null,
    request_id: requestId,
    operation: operacion,
    status,
    latency_ms: Math.round(latenciaMs * 10) / 10,
  };
}
