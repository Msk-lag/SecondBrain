import { Controller } from "@nestjs/common";
import { TsRestHandler, tsRestHandler } from "@ts-rest/nest";
import { healthContract } from "@secondbrain/shared";

@Controller()
export class HealthController {
  @TsRestHandler(healthContract.getHealth)
  handler() {
    return tsRestHandler(healthContract.getHealth, () => {
      return Promise.resolve({ status: 200 as const, body: { status: "ok" as const } });
    });
  }
}
