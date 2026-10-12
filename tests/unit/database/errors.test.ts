import { describe, expect, it } from 'vitest';
import {
  ConcurrencyError,
  ConstraintViolationError,
  DataIntegrityError,
  NotFoundError,
  translateError,
} from '@roi-dealer/database';

describe('database errors', () => {
  it('leave errors that do not come from PostgreSQL unchanged', () => {
    const error = new Error('network down');
    expect(translateError(error)).toBe(error);
    expect(translateError('text')).toBe('text');
  });

  it('describe what happened without row values', () => {
    expect(new NotFoundError('source', 'id-1').message).toBe('source id-1 does not exist');
    expect(new ConcurrencyError('pain', 'id-2', 3, 4).message).toBe(
      'pain id-2 was changed concurrently: expected version 3, found 4',
    );
    expect(
      new ConstraintViolationError('check', '23514', 'sources_markets_check', 'sources').message,
    ).toBe('Database rejected the write (check: sources_markets_check on sources)');
    expect(
      new DataIntegrityError('signal', 'id-3', [{ path: 'evidenceIds', message: 'Too small' }]),
    ).toMatchObject({ name: 'DataIntegrityError', entity: 'signal', id: 'id-3' });
  });
});
