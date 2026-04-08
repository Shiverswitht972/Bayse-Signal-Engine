import crypto from 'node:crypto';

export const BASE_URL = 'https://relay.bayse.markets';

function getEnvOrThrow(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function hashBody(body) {
  const rawBody = body ?? '';
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

export function buildReadHeaders() {
  return {
    'X-Public-Key': getEnvOrThrow('BAYSE_PUBLIC_KEY'),
  };
}

export function buildWriteHeaders(method, path, body) {
  const publicKey = getEnvOrThrow('BAYSE_PUBLIC_KEY');
  const secretKey = getEnvOrThrow('BAYSE_SECRET_KEY');
  const requestTimestamp = String(Math.floor(Date.now() / 1000));
  const upperMethod = method.toUpperCase();
  const bodyHash = hashBody(body);
  const payload = `${requestTimestamp}.${upperMethod}.${path}.${bodyHash}`;

  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(payload)
    .digest('base64');

  return {
    'Content-Type': 'application/json',
    'X-Public-Key': publicKey,
    'X-Timestamp': requestTimestamp,
    'X-Signature': signature,
  };
}
