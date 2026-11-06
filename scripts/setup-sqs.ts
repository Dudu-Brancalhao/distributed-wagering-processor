import { sqsConfigSchema } from "../src/infrastructure/config/config.schema";
import { loadConfig } from "../src/infrastructure/config/load-config";
import { createSqsClient } from "../src/infrastructure/sqs/sqs-client.factory";
import { SqsQueueProvisioner } from "../src/infrastructure/sqs/sqs-queue-provisioner";

const config = loadConfig(sqsConfigSchema);
const queues = await new SqsQueueProvisioner(createSqsClient(config), config).provision();
console.log(JSON.stringify({ event: "sqs.queues_provisioned", ...queues }));
