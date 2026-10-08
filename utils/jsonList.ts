// Helpers to filter Json columns that store lists (MySQL has no native arrays).
// IDs (BigInt) and permissions are stored as TEXT inside the list; days (Days) are stored as NUMBERS.
export const listHas = (value: string | number | bigint) => ({
  path: '$',
  array_contains: String(value),
});

export const listHasNum = (value: number) => ({
  path: '$',
  array_contains: Number(value),
});

export const listHasAny = (field: string, values: Array<string | number | bigint>) =>
  values.map((v) => ({ [field]: listHas(v) }));
