import type { AppLogger } from "./application/ports/app-logger.port";
import { createApp } from "./bootstrap";
import { appConfigSchema } from "./infrastructure/config/config.schema";
import { loadConfig } from "./infrastructure/config/load-config";
import { APP_LOGGER } from "./infrastructure/observability/observability.tokens";

const config = loadConfig(appConfigSchema);
const app = await createApp(config);
await app.listen(config.PORT);
app.get<AppLogger>(APP_LOGGER).info("application started", { event: "app.started", port: config.PORT });
