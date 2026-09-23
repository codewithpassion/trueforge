import { describe, expect, it } from 'vitest';

import { agentDescriptionField } from '@/atoms/lib/agentDescriptionField.js';

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
