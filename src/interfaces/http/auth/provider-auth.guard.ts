import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import type { Request, Response } from "express";
import type { ProviderIdentityPort } from "../../../application/ports/provider-identity.port";
import { PROVIDER_IDENTITY } from "./provider-identity.token";

/**
 * Authentication extension point on every provider-facing route (not on `/health/*` or `/metrics`). It resolves the
 * caller through `ProviderIdentityPort` and keeps the identity on the response locals. With the delivered no-op
 * adapter everyone passes; a real adapter would reject missing or invalid tokens here (401) and the use cases would
 * compare the identity's provider id with the command's (403).
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identities: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const identity = await this.identities.identify(http.getRequest<Request>().header("authorization"));
    http.getResponse<Response>().locals.providerIdentity = identity;
    return true;
  }
}
