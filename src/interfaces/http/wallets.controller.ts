import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from "@nestjs/common";
import type { z } from "zod";
import { CreateWallet } from "../../application/wallets/create-wallet";
import { GetWallet } from "../../application/wallets/get-wallet";
import { ListWalletLedger } from "../../application/wallets/list-wallet-ledger";
import { ReconcileWallet } from "../../application/wallets/reconcile-wallet";
import { uuidField } from "../shared/input-formats";
import { ProviderAuthGuard } from "./auth/provider-auth.guard";
import { ledgerPageView, reconciliationView, walletView } from "./presenters/wallet.presenter";
import { CurrentRequestIds, type RequestIds } from "./request-ids";
import { createWalletBodySchema, ledgerPageQuerySchema } from "./schemas/wallet-requests.schema";

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly getWallet: GetWallet,
    private readonly listWalletLedger: ListWalletLedger,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  async create(
    @Body({ schema: createWalletBodySchema }) body: z.output<typeof createWalletBodySchema>,
    @CurrentRequestIds() ids: RequestIds,
  ) {
    const wallet = await this.createWallet.execute(body, {
      correlationId: ids.correlationId,
      causationId: ids.requestId,
    });
    return walletView(wallet);
  }

  @Get(":walletId")
  async findOne(@Param("walletId", { schema: uuidField }) walletId: string) {
    return walletView(await this.getWallet.execute(walletId));
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId", { schema: uuidField }) walletId: string,
    @Query({ schema: ledgerPageQuerySchema }) query: z.output<typeof ledgerPageQuerySchema>,
  ) {
    const page = await this.listWalletLedger.execute({ walletId, beforeVersion: query.cursor, limit: query.limit });
    return ledgerPageView(page);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param("walletId", { schema: uuidField }) walletId: string) {
    return reconciliationView(await this.reconcileWallet.execute(walletId));
  }
}
