// @pi-lead-child/store/testing：给其他包的测试用的 fixture，不进生产代码。
import { fileURLToPath } from "node:url";

// v16 改名之前 openDb 产出的物理 schema。改名迁移和 doctor 的迁移预检都从它起步。
export const V15_SCHEMA_FIXTURE = fileURLToPath(new URL("./fixtures/v15-schema.sql", import.meta.url));
