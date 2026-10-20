/**
 * JSON schema `pattern` for free text that reaches Postgres. Text there can't hold NUL characters,
 * so they're refused with the other schema errors instead of failing in the database.
 */
export const NO_NUL = '^[^\\u0000]*$';
