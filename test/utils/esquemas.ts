import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { RUTA_CONTRATO, RUTA_CONTRATO_V2 } from '../../src/rutas/contrato-core';

/**
 * El ProblemDetails de cada contrato del core (v1 y v2), compilado con Ajv 8 desde la copia
 * vendored: un error del borde se valida contra el MISMO esquema que valida Booking, no contra
 * una lista de campos escrita a mano.
 */
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(parse(readFileSync(RUTA_CONTRATO, 'utf8')) as object, 'v1');
ajv.addSchema(parse(readFileSync(RUTA_CONTRATO_V2, 'utf8')) as object, 'v2');

const validadores: Record<'v1' | 'v2', ValidateFunction> = {
  v1: ajv.getSchema('v1#/components/schemas/ProblemDetails')!,
  v2: ajv.getSchema('v2#/components/schemas/ProblemDetails')!,
};

/** Los errores de Ajv si el cuerpo no cumple el ProblemDetails de ese contrato; [] si cumple. */
export function erroresDeProblema(version: 'v1' | 'v2', cuerpo: unknown): string[] {
  const validar = validadores[version];
  if (validar(cuerpo)) return [];
  return (validar.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ''}`.trim());
}
