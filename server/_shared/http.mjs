
export const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", ...headers },
  body: JSON.stringify(body),
});

// Operator authentication lives in operator-auth.mjs (organization-scoped identity).
