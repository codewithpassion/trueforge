import { describe, expect, it } from 'vitest';

import { readApiError, readErrorShapedMessage } from '@/utils/readApiError.js';

describe('readApiError', () => {
  it('reads status, code and message from an SDK status error', () => {
    const error = Object.assign(new Error('Status code: 409'), {
      statusCode: 409,
      body: { error: { code: 'tip_running', message: 'Someone else answered.' } },
    });
    expect(readApiError(error)).toEqual({ status: 409, code: 'tip_running', message: 'Someone else answered.' });
  });

  it('prefers a top-level body message over the envelope', () => {
    expect(readApiError({ statusCode: 500, body: { message: 'top', error: { message: 'nested' } } }).message).toBe(
      'top',
    );
  });

  it('leaves fields it cannot read undefined', () => {
    expect(readApiError(new Error('network down'))).toEqual({
      status: undefined,
      code: undefined,
      message: undefined,
    });
    expect(readApiError({ statusCode: '409', body: { error: { code: 7, message: '  ' } } })).toEqual({
      status: undefined,
      code: undefined,
      message: undefined,
    });
    expect(readApiError('boom')).toEqual({ status: undefined, code: undefined, message: undefined });
  });
});

describe('readErrorShapedMessage', () => {
  it('reads `message`, then `error.message`', () => {
    expect(readErrorShapedMessage({ message: 'direct' })).toBe('direct');
    expect(readErrorShapedMessage({ error: { message: 'nested' } })).toBe('nested');
    expect(readErrorShapedMessage({ message: '' })).toBeUndefined();
    expect(readErrorShapedMessage(null)).toBeUndefined();
  });
});
