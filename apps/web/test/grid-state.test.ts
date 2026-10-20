import type { Filter } from '@wardenhq/core';
import { describe, expect, it } from 'vitest';
import {
  listUrl,
  maxPage,
  parseSort,
  readGridState,
  showsView,
  viewParams,
  viewStateOf,
  writeGridState,
} from '../src/lib/grid-state';
import { orders } from './fixtures';

const read = (search: string) => readGridState(new URLSearchParams(search), orders);

describe('readGridState', () => {
  it('falls back to the default sort and first page', () => {
    expect(read('')).toEqual({
      sort: [{ field: 'placed_at', direction: 'desc' }],
      q: '',
      page: 1,
      pageSize: 50,
    });
  });

  it('reads sort, filter, search, and paging', () => {
    expect(read('sort=-total,id&filter=%7B%7D&q=gift&page=3&pageSize=100')).toEqual({
      sort: [
        { field: 'total', direction: 'desc' },
        { field: 'id', direction: 'asc' },
      ],
      filter: '{}',
      q: 'gift',
      page: 3,
      pageSize: 100,
    });
  });

  it.each(['page=0', 'page=-1', 'page=abc', 'page=1.5'])('ignores a bad page (%s)', (search) => {
    expect(read(search).page).toBe(1);
  });

  it('reads visible columns in entity order, ignoring unknown ones', () => {
    expect(read('columns=total,id,nope').columns).toEqual(['id', 'total']);
    // Every column, or none that exist, means the default: all of them.
    expect(read('columns=nope').columns).toBeUndefined();
    expect(read(`columns=${orders.fields.map((f) => f.name).join(',')}`).columns).toBeUndefined();
  });

  it('only allows the offered page sizes', () => {
    expect(read('pageSize=7').pageSize).toBe(50);
    expect(read('pageSize=100000').pageSize).toBe(50);
  });
});

describe('parseSort', () => {
  it('handles prefixes and whitespace', () => {
    expect(parseSort(' -a , +b,,c ')).toEqual([
      { field: 'a', direction: 'desc' },
      { field: 'b', direction: 'asc' },
      { field: 'c', direction: 'asc' },
    ]);
  });
});

describe('writeGridState', () => {
  const write = (search: string, update: Parameters<typeof writeGridState>[1]) =>
    writeGridState(new URLSearchParams(search), update).toString();

  it('goes back to page 1 when the query changes', () => {
    expect(write('page=4&q=a', { q: 'b' })).toBe('q=b');
    expect(write('page=4', { sort: [{ field: 'total', direction: 'desc' }] })).toBe('sort=-total');
    expect(write('page=4', { filter: '{"field":"id","op":"isNull"}' })).toBe(
      'filter=%7B%22field%22%3A%22id%22%2C%22op%22%3A%22isNull%22%7D',
    );
    expect(write('page=4&pageSize=25', { pageSize: 100 })).toBe('pageSize=100');
  });

  it('keeps the rest of the state when paging', () => {
    expect(write('q=a&sort=id', { page: 2 })).toBe('q=a&sort=id&page=2');
    expect(write('q=a&page=2', { page: 1 })).toBe('q=a');
  });

  it('drops defaults and cleared values', () => {
    expect(write('filter=x&q=a&pageSize=25', { filter: null, q: '  ', pageSize: 50 })).toBe('');
  });

  it('keeps the page when only columns change', () => {
    expect(write('page=3', { columns: ['id', 'total'] })).toBe('page=3&columns=id%2Ctotal');
    expect(write('page=3&columns=id', { columns: null })).toBe('page=3');
  });
});

describe('saved view state', () => {
  const filter: Filter = { field: 'status', op: 'eq', value: 'paid' };
  const params = (search: string) => new URLSearchParams(search);

  it('converts between a view and grid params', () => {
    const state = { filter, q: 'gift', sort: '-total', columns: ['id', 'total'] };
    const search = viewParams(state);
    expect(Object.fromEntries(search)).toEqual({
      sort: '-total',
      filter: JSON.stringify(filter),
      q: 'gift',
      columns: 'id,total',
    });
    expect(viewStateOf(search, orders)).toEqual(state);
    expect(viewStateOf(params('page=2&pageSize=25'), orders)).toEqual({});
    // An unparseable filter can't be saved; the grid shows the server's error for it.
    expect(viewStateOf(params('filter=%7Bnope'), orders)).toEqual({});
  });

  it('matches a view regardless of page, filter key order, and column order', () => {
    const state = { filter, sort: '-total', columns: ['total', 'id'] };
    const search = `sort=-total&columns=id,total&page=3&pageSize=25&filter=${encodeURIComponent(
      '{"value":"paid","op":"eq","field":"status"}',
    )}`;
    expect(showsView(params(search), orders, state)).toBe(true);
    expect(showsView(params(search + '&q=x'), orders, state)).toBe(false);
    expect(showsView(params('sort=-total'), orders, state)).toBe(false);
    expect(showsView(params(''), orders, {})).toBe(true);
  });
});

describe('listUrl', () => {
  it('asks the server to sort, filter, search, and paginate', () => {
    const url = new URL(
      listUrl(orders, read('sort=-total&filter=%7B%7D&q=gift&page=3&pageSize=25')),
      'http://x',
    );
    expect(url.pathname).toBe('/api/entities/orders');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      sort: '-total',
      filter: '{}',
      q: 'gift',
      limit: '25',
      offset: '50',
      count: 'true',
    });
  });

  it('omits the offset on the first page and encodes the entity key', () => {
    const url = listUrl({ ...orders, key: 'audit.log/x' }, read(''));
    expect(url).toBe('/api/entities/audit.log%2Fx?sort=-placed_at&limit=50&count=true');
  });
});

describe('maxPage', () => {
  it('stays within the server offset cap', () => {
    expect(maxPage(50)).toBe(2001);
    expect((maxPage(200) - 1) * 200).toBeLessThanOrEqual(100_000);
  });
});
