import type { ProviderIdentity, ProviderIdentityPort } from "../../../application/ports/provider-identity.port";

/** No-op adapter of the authentication extension point: every caller is anonymous (OQ-01). */
export class AnonymousProviderIdentity implements ProviderIdentityPort {
  async identify(): Promise<ProviderIdentity> {
    return { kind: "anonymous" };
  }
}
