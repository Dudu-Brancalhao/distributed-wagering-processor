import { Body, Controller, Get, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { GetWagerTransaction } from "../../application/wagering/get-wager-transaction";
import { SubmitWagerTransaction } from "../../application/wagering/submit-wager-transaction";
import { externalIdField, providerIdField, uuidField } from "../shared/input-formats";
import {
  type WagerTransactionRequest,
  wagerTransactionRequestSchema,
} from "../shared/wager-transaction-request.schema";
import { ProviderAuthGuard } from "./auth/provider-auth.guard";
import { IdempotencyKey } from "./idempotency-key.decorator";
import { submissionStatusCode, submissionView, transactionView } from "./presenters/wager-transaction.presenter";
import { CurrentRequestIds, type RequestIds } from "./request-ids";

@Controller()
@UseGuards(ProviderAuthGuard)
export class WagerTransactionsController {
  constructor(
    private readonly submitWagerTransaction: SubmitWagerTransaction,
    private readonly getWagerTransaction: GetWagerTransaction,
  ) {}

  /** 201 PROCESSED, 202 PENDING_REFERENCE, 422 REJECTED or FAILED; identical for the first response and replays. */
  @Post("wagering/transactions")
  async submit(
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: wagerTransactionRequestSchema }) body: WagerTransactionRequest,
    @CurrentRequestIds() ids: RequestIds,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.submitWagerTransaction.execute(
      { ...body, idempotencyKey },
      { correlationId: ids.correlationId, causationId: ids.requestId, source: "http" },
    );
    response.status(submissionStatusCode(result.transaction));
    return submissionView(result);
  }

  @Get("wagering/transactions/:transactionId")
  async findById(@Param("transactionId", { schema: uuidField }) transactionId: string) {
    return transactionView(await this.getWagerTransaction.byId(transactionId));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async findByExternalId(
    @Param("providerId", { schema: providerIdField }) providerId: string,
    @Param("externalTransactionId", { schema: externalIdField }) externalTransactionId: string,
  ) {
    return transactionView(await this.getWagerTransaction.byExternalId(providerId, externalTransactionId));
  }
}
