import { Global, Module } from "@nestjs/common";
import { createDb, createPoolFromEnv, type Database } from "@secondbrain/db";

export const DRIZZLE = "DRIZZLE";

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      useFactory: (): Database => createDb(createPoolFromEnv()),
    },
  ],
  exports: [DRIZZLE],
})
export class DbModule {}
