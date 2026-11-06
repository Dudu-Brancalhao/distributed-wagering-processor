import "reflect-metadata";
import { APP_CONFIG } from "../../../src/infrastructure/config/app-config.token";
import { type AppConfig, appConfigSchema } from "../../../src/infrastructure/config/config.schema";
import { loadConfig } from "../../../src/infrastructure/config/load-config";
import { SQS_CLIENT } from "../../../src/infrastructure/sqs/sqs.tokens";
import { SqsQueueGateway } from "../../../src/infrastructure/sqs/sqs-queue-gateway";
import { SqsQueueUrls } from "../../../src/infrastructure/sqs/sqs-queue-urls";
import { createCustomizedApp } from "../test-app";

/**
 * T-C5 entrypoint (spec 3.21): the real application, except that acknowledging a message kills the process. The
 * consumer acknowledges only after the commit, so the crash lands exactly between the commit and `DeleteMessage`.
 */
class CrashOnAckGateway extends SqsQueueGateway {
  override async delete(): Promise<void> {
    process.kill(process.pid, "SIGKILL");
  }
}

const config = loadConfig(appConfigSchema);
const app = await createCustomizedApp(config, (builder) =>
  builder.overrideProvider(SqsQueueGateway).useFactory({
    factory: (sqs, urls, appConfig: AppConfig) => new CrashOnAckGateway(sqs, urls, appConfig),
    inject: [SQS_CLIENT, SqsQueueUrls, APP_CONFIG],
  }),
);
app.enableShutdownHooks();
await app.listen(config.PORT);
