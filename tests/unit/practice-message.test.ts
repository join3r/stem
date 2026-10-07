import { describe, expect, it } from 'vitest';
import { practiceMessage } from '../../src/shared/practice-message';

describe('practiceMessage', () => {
  it('lists the draft’s final steps and puts the caret after "on: "', () => {
    const { text, caret } = practiceMessage('set-agrisys-delivery-date', ['Click "Uložiť" in agrisys (saves the date)', ' Press "y" in Fastmail (archives the email) ', '']);
    expect(text.slice(0, caret)).toBe('Practice the "set-agrisys-delivery-date" skill on: ');
    expect(text).toContain('(I delete a line to let you do it):\n- Click "Uložiť" in agrisys (saves the date)\n- Press "y" in Fastmail (archives the email)\n\n');
    expect(text).toMatch(/tell me what and how you got past it\.$/);
    expect(text).toContain('If I leave that empty, take the newest case');
  });

  it('falls back to a general line when the draft names no final steps', () => {
    for (const steps of [undefined, []]) {
      expect(practiceMessage('x', steps).text).toContain('- anything that saves, submits, sends, archives, moves or deletes something');
    }
  });
});
