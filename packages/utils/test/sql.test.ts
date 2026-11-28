import { describe, expect, it } from 'vitest';

import { sqlList, sqlLiteral } from '../src/sql.ts';

describe('sqlLiteral', () => {
  it('quotes a string and doubles its quotes', () => {
    expect(sqlLiteral('entire_home')).toBe("'entire_home'");
    expect(sqlLiteral("O'Malley")).toBe("'O''Malley'");
  });
});

describe('sqlList', () => {
  it('lists literals for IN', () => {
    expect(sqlList(['private_room', 'shared_room'])).toBe("('private_room', 'shared_room')");
  });
});
