import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const COOKIE_NAME = 'mainworker_session';

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readCookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return index === -1
          ? [part, '']
          : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

export function createAuth(dataDirectory) {
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDirectory, 0o700);
  const tokenFile = path.join(dataDirectory, 'access-token');
  const configuredToken = process.env.WORKBENCH_TOKEN?.trim();
  let accessToken = configuredToken;

  if (!accessToken) {
    if (fs.existsSync(tokenFile)) {
      accessToken = fs.readFileSync(tokenFile, 'utf8').trim();
    } else {
      accessToken = crypto.randomBytes(32).toString('base64url');
      fs.writeFileSync(tokenFile, `${accessToken}\n`, { mode: 0o600 });
    }
  }

  const sessionValue = crypto
    .createHmac('sha256', accessToken)
    .update('mainworker-session-v1')
    .digest('base64url');

  return {
    tokenFile,
    tokenSource: configuredToken ? 'environment' : 'file',
    verifyToken(candidate) {
      return secureEqual(candidate, accessToken);
    },
    isAuthenticated(request) {
      return secureEqual(readCookies(request)[COOKIE_NAME], sessionValue);
    },
    setSession(response, request) {
      const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
      const secure = request.socket.encrypted || forwardedProto === 'https';
      const attributes = [
        `${COOKIE_NAME}=${encodeURIComponent(sessionValue)}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        'Max-Age=2592000',
      ];
      if (secure) attributes.push('Secure');
      response.setHeader('Set-Cookie', attributes.join('; '));
    },
    clearSession(response) {
      response.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    },
  };
}
