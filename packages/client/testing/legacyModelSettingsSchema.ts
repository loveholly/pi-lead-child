// 旧版 Companion（Lead 模型分组之前，2026-11-05 以前）校验 GET /v1/models/settings 用的 schema：
// 和现在的一样严格（additionalProperties: false），只是 BrainModel 没有 group、source，ModelProvider 没有「高级」的四个字段。
// 从现在的 schema 拿掉这些字段拼出来：别的字段以后再变，这里跟着变；只有分组的字段固定是「旧版不认」。
import {
  BrainSettingsSchema, BrainModelSchema, ModelProviderSchema, ModelSettingsDtoSchema, ModelSettingsResponseSchema,
} from '@pi-lead-child/protocol';
import { Type, type TProperties, type TSchema } from 'typebox';

function without(schema: TSchema, keys: readonly string[]): TSchema {
  const properties = { ...(schema as unknown as { properties: TProperties }).properties };
  for (const key of keys) delete properties[key];
  return Type.Object(properties, { additionalProperties: false });
}

function replaced(schema: TSchema, key: string, value: TSchema): TSchema {
  const properties = { ...(schema as unknown as { properties: TProperties }).properties, [key]: value };
  return Type.Object(properties, { additionalProperties: false });
}

const LegacyBrainModelSchema = without(BrainModelSchema, ['group', 'source']);
const LegacyModelProviderSchema = replaced(
  without(ModelProviderSchema, ['accountPrefix', 'accountPrefixActive', 'capabilities', 'catalog']),
  'models', Type.Array(LegacyBrainModelSchema, { maxItems: 2000 }),
);
const LegacyBrainSettingsSchema = replaced(BrainSettingsSchema, 'providers', Type.Array(LegacyModelProviderSchema, { maxItems: 32 }));
const LegacyModelSettingsDtoSchema = replaced(ModelSettingsDtoSchema, 'brain', LegacyBrainSettingsSchema);

export const LegacyModelSettingsResponseSchema = replaced(ModelSettingsResponseSchema, 'modelSettings', LegacyModelSettingsDtoSchema);
