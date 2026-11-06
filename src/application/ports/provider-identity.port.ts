export type ProviderIdentity =
  | { readonly kind: "anonymous" }
  | { readonly kind: "provider"; readonly providerId: string };

/**
 * Authentication extension point (OQ-01). The delivered adapter accepts every caller as anonymous; a real adapter
 * would validate the provider's token against the IdP and return its `provider_id` claim.
 */
export interface ProviderIdentityPort {
  identify(credentials: string | undefined): Promise<ProviderIdentity>;
}
