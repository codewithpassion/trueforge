import { describe, expect, it } from 'vitest';

import { agentDescriptionField, storedAgentDescription } from '@/atoms/lib/agentDescriptionField.js';

describe('agentDescriptionField', () => {
  it('trims a submitted description', () => {
    expect(agentDescriptionField('  Writes docs.  ')).toEqual({ description: 'Writes docs.' });
  });

  it('keeps a blank description so the stored one is cleared', () => {
    expect(agentDescriptionField('   ')).toEqual({ description: '' });
  });

  it('omits an unknown description so the stored one is kept', () => {
    expect(agentDescriptionField(undefined)).toEqual({});
  });
});

describe('storedAgentDescription', () => {
  it('trims a real description', () => {
    expect(storedAgentDescription({ name: 'writer', description: '  Writes docs.  ' })).toBe('Writes docs.');
  });

  it('reads a legacy name-as-description as empty', () => {
    expect(storedAgentDescription({ name: 'writer', description: ' writer ' })).toBe('');
  });

  it('keeps an unknown description unknown', () => {
    expect(storedAgentDescription({ name: 'writer', description: undefined })).toBeUndefined();
  });
});
