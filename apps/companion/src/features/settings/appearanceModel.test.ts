import { DEFAULT_DESIGN_PREFERENCES, designPreferencesFields } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { appearanceChanges, appearanceForm, appearanceFormProblem, appearanceResetRequest, appearanceUpdatedLine } from './appearanceModel';

// 设置 → 外观（2026-10-22）的表单规则：只发改了的字段，缺省恢复不碰设计说明，颜色按整理后的值比较。
describe('appearance form', () => {
  const saved = designPreferencesFields(DEFAULT_DESIGN_PREFERENCES);

  it('sends only the changed fields', () => {
    const form = appearanceForm(saved);
    expect(appearanceChanges(form, saved)).toBeNull();
    form['density.ticket'] = 'standard';
    form['colors.accent'] = ' #1e51d6 ';
    form.notes = '喜欢大圆角\n';
    expect(appearanceChanges(form, saved)).toEqual({ density: { ticket: 'standard' }, colors: { accent: '#1E51D6' }, notes: '喜欢大圆角' });
  });

  it('reports a color below the readability floor before saving', () => {
    expect(appearanceFormProblem({ colors: { accent: '#9DB8FF' } })).toContain('主色太浅');
    expect(appearanceFormProblem({ radius: 'round' })).toBeNull();
  });

  it('resets everything except the notes', () => {
    const custom = { ...saved, radius: 'round' as const, notes: '留着' };
    expect(appearanceResetRequest(custom)).toEqual({ radius: 'soft' });
    expect(appearanceResetRequest({ ...saved, notes: '留着' })).toBeNull();
  });

  it('says who changed it last', () => {
    expect(appearanceUpdatedLine(DEFAULT_DESIGN_PREFERENCES, 'Paimon', new Date())).toBeNull();
    const line = appearanceUpdatedLine({ ...DEFAULT_DESIGN_PREFERENCES, updatedAt: '2026-10-22T07:00:00.000Z', updatedBy: 'lead' }, 'Paimon', new Date('2026-10-22T09:00:00.000Z'));
    expect(line).toContain('Paimon 在对话里按你的要求改的');
  });
});
