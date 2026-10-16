import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { calculateJwkThumbprint, CryptoKey, exportJWK, generateKeyPair, JWK, SignJWT } from 'jose';

export const EMISOR = 'https://gateway.quinde.example';
export const AUDIENCIA = 'quinde-vuelos-api';

export interface OpcionesToken {
  scope?: string;
  sub?: string;
  iss?: string;
  aud?: string;
  /** Segundos desde ahora (negativo: vencido). Por defecto 900. */
  expiraEn?: number;
  kid?: string;
  typ?: string;
  clientId?: string;
  /** Hora de emisión (la del RelojDePrueba). */
  ahora?: Date;
}

/**
 * Un identity falso con lo que el gateway necesita: un par RSA efímero, su JWKS por HTTP (con
 * Cache-Control como el real) y tokens de acceso firmados como los de identity_vuelos (RS256,
 * typ at+jwt, kid = huella RFC 7638). Se puede "apagar" (500) para probar el 503.
 */
export class IdentidadFalsa {
  privada!: CryptoKey;
  publica!: CryptoKey;
  jwkPublica!: JWK;
  kid!: string;
  encendida = true;
  descargas = 0;
  private servidor?: Server;

  async iniciar(): Promise<this> {
    const par = await generateKeyPair('RS256', { extractable: true });
    this.privada = par.privateKey;
    this.publica = par.publicKey;
    this.jwkPublica = await exportJWK(this.publica);
    this.kid = await calculateJwkThumbprint(this.jwkPublica);

    this.servidor = createServer((peticion, respuesta) => {
      if (peticion.url !== '/.well-known/jwks.json') {
        respuesta.writeHead(404).end();
        return;
      }
      this.descargas++;
      if (!this.encendida) {
        respuesta.writeHead(500).end();
        return;
      }
      respuesta.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=300',
      });
      respuesta.end(
        JSON.stringify({ keys: [{ ...this.jwkPublica, kid: this.kid, alg: 'RS256', use: 'sig' }] }),
      );
    });
    await new Promise<void>((listo) => this.servidor!.listen(0, '127.0.0.1', listo));
    return this;
  }

  get jwksUrl(): string {
    const { port } = this.servidor!.address() as AddressInfo;
    return `http://127.0.0.1:${port}/.well-known/jwks.json`;
  }

  async token(opciones: OpcionesToken = {}): Promise<string> {
    const ahora = Math.floor((opciones.ahora ?? new Date()).getTime() / 1000);
    const claims: Record<string, unknown> = { scope: opciones.scope ?? '' };
    if (opciones.clientId) claims.client_id = opciones.clientId;
    return new SignJWT(claims)
      .setProtectedHeader({
        alg: 'RS256',
        typ: opciones.typ ?? 'at+jwt',
        kid: opciones.kid ?? this.kid,
      })
      .setIssuer(opciones.iss ?? EMISOR)
      .setAudience(opciones.aud ?? AUDIENCIA)
      .setSubject(opciones.sub ?? randomUUID())
      .setJti(randomUUID())
      .setIssuedAt(ahora)
      .setExpirationTime(ahora + (opciones.expiraEn ?? 900))
      .sign(this.privada);
  }

  async detener(): Promise<void> {
    if (!this.servidor) return;
    this.servidor.closeAllConnections();
    await new Promise<void>((listo) => this.servidor!.close(() => listo()));
  }
}
