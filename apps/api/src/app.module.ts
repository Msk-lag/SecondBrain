import { Module } from "@nestjs/common";
import { HealthModule } from "./modules/health/health.module";
import { AuthModule } from "./modules/auth/auth.module";
import { NotesModule } from "./modules/notes/notes.module";
import { DbModule } from "./db/db.module";

@Module({
  imports: [DbModule, HealthModule, AuthModule, NotesModule],
})
export class AppModule {}
