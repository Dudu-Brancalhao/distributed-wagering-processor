import { Module } from "@nestjs/common";
import { AnonymousProviderIdentity } from "./auth/anonymous-provider-identity";
import { ProviderAuthGuard } from "./auth/provider-auth.guard";
import { PROVIDER_IDENTITY } from "./auth/provider-identity.token";
import { WagerTransactionsController } from "./wager-transactions.controller";
import { WalletsController } from "./wallets.controller";

/** Role `api`: the provider-facing wallet and wagering endpoints. */
@Module({
  controllers: [WalletsController, WagerTransactionsController],
  providers: [{ provide: PROVIDER_IDENTITY, useValue: new AnonymousProviderIdentity() }, ProviderAuthGuard],
})
export class WageringApiModule {}
