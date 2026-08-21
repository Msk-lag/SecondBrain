import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import type { AuthenticatedUser } from "@secondbrain/shared";
import { getRequiredJwtSecret } from "./jwt-secret";
import type { JwtPayload } from "./auth.service";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getRequiredJwtSecret(),
      // アルゴリズムを HS256 に固定する(アルゴリズム混同攻撃対策)。RFC 8725(JWT BCP)
      // §3.1 は「検証者は受信した JWT の `alg` ヘッダを信用せず、明示的な許可リストで
      // アルゴリズムを制限する」ことを求めており、この行はその要求を満たすもの。
      // なお現行の jsonwebtoken(9 系)は鍵種(文字列の秘密鍵)から既定の許可アルゴリズムを
      // 絞るため、この行が無くても `alg: "none"` や非対称鍵アルゴリズムへの差し替えは
      // 既に拒否される。つまりこれは「今すぐ塞がる穴」ではなく、ライブラリの実装・
      // バージョンに依存しない多層防御(defense in depth)であり、仕様側の要求をコードで
      // 明示しておくことで、ライブラリの既定挙動が将来変わっても崩れないようにする狙い。
      algorithms: ["HS256"],
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    return { id: payload.sub, email: payload.email };
  }
}
