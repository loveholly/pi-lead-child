import { Type, type Static } from "typebox";

// 这个文件只依赖 typebox：index.ts 和 admin.ts、local-sockets.ts 都从这里取值，不形成循环引用。

// scope 名是线上契约，不随内部改名走。
export const ScopeSchema = Type.Union([
  Type.Literal("chat"),
  Type.Literal("tickets:view"),
  Type.Literal("tickets:create"),
  Type.Literal("approvals:respond"),
  Type.Literal("notices"),
  // 管理权限（配对、撤销 binding、aish 凭证）。缺省不授予，见 admin.ts 的 ADMIN_SCOPE。
  Type.Literal("admin"),
]);
export type Scope = Static<typeof ScopeSchema>;

export const ALL_SCOPES: Scope[] = [
  "chat", "tickets:view", "tickets:create", "approvals:respond", "notices", "admin",
];

export const BindingDtoSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  kind: Type.String(),
  name: Type.String(),
  scopes: Type.Array(ScopeSchema),
}, { additionalProperties: false });
export type BindingDto = Static<typeof BindingDtoSchema>;
