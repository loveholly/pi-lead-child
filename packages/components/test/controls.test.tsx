import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button, Chip, IconButton, SegmentedControl, Switch, TextField } from '../src';
import { renderUI } from './render';

describe('Button', () => {
  it('renders its label as a button and calls onPress', () => {
    const onPress = vi.fn();
    renderUI(<Button label="授权" onPress={onPress} testID="grant" />);
    const button = screen.getByTestId('grant');
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toBe('授权');
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not call onPress while disabled', () => {
    const onPress = vi.fn();
    renderUI(<Button label="停下" onPress={onPress} disabled testID="stop" />);
    fireEvent.click(screen.getByTestId('stop'));
    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByTestId('stop').getAttribute('aria-disabled')).toBe('true');
  });
});

describe('IconButton', () => {
  it('uses the label as its accessible name and default test id', () => {
    const onPress = vi.fn();
    renderUI(<IconButton icon="sidebar" label="打开工作列表" onPress={onPress} />);
    const button = screen.getByTestId('打开工作列表');
    expect(button.getAttribute('aria-label')).toBe('打开工作列表');
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('TextField', () => {
  function Controlled({ onSubmit }: { onSubmit: (text: string) => void }) {
    const [value, setValue] = useState('');
    return (
      <TextField
        value={value}
        onChangeText={setValue}
        onSubmit={(text) => { onSubmit(text); setValue(''); }}
        placeholder="给 Lead 发消息…"
        testID="composer"
      />
    );
  }

  it('is controlled by a plain string and reports submits', () => {
    const onSubmit = vi.fn();
    renderUI(<Controlled onSubmit={onSubmit} />);
    const input = screen.getByTestId('composer') as HTMLInputElement;
    expect(input.placeholder).toBe('给 Lead 发消息…');
    fireEvent.change(input, { target: { value: '你好' } });
    expect(input.value).toBe('你好');
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, nativeEvent: { text: '你好' } });
    expect(onSubmit).toHaveBeenCalledWith('你好');
    expect(input.value).toBe('');
  });

  it('is read-only while disabled', () => {
    renderUI(<TextField value="x" onChangeText={() => {}} disabled testID="field" />);
    expect((screen.getByTestId('field') as HTMLInputElement).readOnly).toBe(true);
  });

  it('hides a secret and tells the browser not to fill a saved password into it', () => {
    renderUI(<TextField value="" onChangeText={() => {}} secure autoComplete="new-password" testID="key" />);
    const input = screen.getByTestId('key') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('new-password');
  });

  it('shows typed characters as they are in a mono field, without code ligatures', () => {
    renderUI(<TextField value="https://api.typesafe.ai" onChangeText={() => {}} mono testID="url" />);
    expect(getComputedStyle(screen.getByTestId('url')).fontVariantLigatures).toBe('none');
  });
});

describe('Chip', () => {
  it('shows its count and pressed state', () => {
    const onPress = vi.fn();
    renderUI(<Chip label="需要我" count={2} selected onPress={onPress} testID="todo" />);
    const chip = screen.getByTestId('todo');
    expect(chip.textContent).toBe('需要我2');
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chip);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('SegmentedControl', () => {
  it('marks the selected option and reports a change', () => {
    const onChange = vi.fn();
    renderUI(
      <SegmentedControl
        options={[{ value: 'inbox', label: '收件箱' }, { value: 'tickets', label: '工单' }]}
        value="inbox"
        onChange={onChange}
        optionTestID={(value) => `rail-view-${value}`}
      />,
    );
    expect(screen.getByTestId('rail-view-inbox').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('rail-view-tickets').getAttribute('aria-selected')).toBe('false');
    fireEvent.click(screen.getByTestId('rail-view-tickets'));
    expect(onChange).toHaveBeenCalledWith('tickets');
  });
});

describe('Switch', () => {
  it('toggles its value', () => {
    const onValueChange = vi.fn();
    renderUI(<Switch value={false} onValueChange={onValueChange} label="无人值守" testID="unattended" />);
    const toggle = screen.getByTestId('unattended');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(onValueChange).toHaveBeenCalledWith(true);
  });
});
