import { SQSClient } from "@aws-sdk/client-sqs";
import type { SqsConfig } from "../config/config.schema";

export function createSqsClient(config: SqsConfig): SQSClient {
  return new SQSClient({
    endpoint: config.SQS_ENDPOINT,
    region: config.AWS_REGION,
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
  });
}
